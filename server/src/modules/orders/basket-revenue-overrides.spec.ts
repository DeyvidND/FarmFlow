import { loadBasketRevenueOverrides, basketAwareLineRevenueSql } from './basket-revenue-overrides';

const TENANT = 't1';

/** A minimal chainable Drizzle mock: `db.selectDistinct()`/`db.select()` each
 *  return a builder whose `.from().innerJoin().where()` resolves to the next
 *  queued row array (FIFO), matching the positional-queue style used by
 *  commission.service.spec.ts. */
function makeDb(queue: unknown[][]) {
  let idx = 0;
  const builder: any = {};
  builder.from = jest.fn(() => builder);
  builder.innerJoin = jest.fn(() => builder);
  builder.where = jest.fn(() => Promise.resolve(queue[idx++] ?? []));
  return {
    select: jest.fn(() => builder),
    selectDistinct: jest.fn(() => builder),
  };
}

describe('loadBasketRevenueOverrides', () => {
  it('returns an empty map with only ONE query when the tenant has no basket orders', async () => {
    const db = makeDb([[]]); // selectDistinct → no basket order ids at all
    const overrides = await loadBasketRevenueOverrides(db as never, TENANT);
    expect(overrides.size).toBe(0);
    expect((db.select as jest.Mock)).not.toHaveBeenCalled(); // short-circuits before the 2nd query
  });

  it('allocates every basket child across the orders it finds, grouped per order', async () => {
    const db = makeDb([
      [{ orderId: 'order-1' }, { orderId: 'order-2' }], // selectDistinct: two orders contain a basket
      [
        // order-1: parent 3990 split between two children (weights 400/600 → 1596/2394)
        { id: 'parent-1', orderId: 'order-1', bundleParentId: null, quantity: 1, priceStotinki: 3990, memberPriceStotinki: 3990 },
        { id: 'child-1a', orderId: 'order-1', bundleParentId: 'parent-1', quantity: 2, priceStotinki: 0, memberPriceStotinki: 200 },
        { id: 'child-1b', orderId: 'order-1', bundleParentId: 'parent-1', quantity: 1, priceStotinki: 0, memberPriceStotinki: 600 },
        // order-2: single-child basket, full price to the one child
        { id: 'parent-2', orderId: 'order-2', bundleParentId: null, quantity: 1, priceStotinki: 1500, memberPriceStotinki: 1500 },
        { id: 'child-2a', orderId: 'order-2', bundleParentId: 'parent-2', quantity: 1, priceStotinki: 0, memberPriceStotinki: 1500 },
      ],
    ]);
    const overrides = await loadBasketRevenueOverrides(db as never, TENANT);
    expect(overrides.get('child-1a')).toBe(1596);
    expect(overrides.get('child-1b')).toBe(2394);
    expect(overrides.get('child-2a')).toBe(1500);
    // Parent rows come back too (their own priceStotinki × quantity — a no-op
    // override vs. what the SQL default would already compute) — the map
    // covers every row loadBasketRevenueOverrides fetched, orders don't leak
    // into each other's allocation, and nothing beyond these 2 orders' 5 rows
    // sneaks in.
    expect(overrides.get('parent-1')).toBe(3990);
    expect(overrides.get('parent-2')).toBe(1500);
    expect(overrides.size).toBe(5);
  });
});

/** Flattens a drizzle `SQL` object's (possibly nested) queryChunks into the
 *  literal SQL text it was built from, for asserting shape in a test without
 *  a live Postgres connection to actually run it against. */
function literalText(node: { queryChunks: unknown[] }): string {
  let out = '';
  for (const c of node.queryChunks) {
    const chunk = c as { value?: string[]; queryChunks?: unknown[] };
    if (chunk?.value) out += chunk.value.join('');
    else if (chunk?.queryChunks) out += literalText(chunk as { queryChunks: unknown[] });
  }
  return out;
}

describe('basketAwareLineRevenueSql', () => {
  it('renders a bare multiplication (no CASE) when there is nothing to override', () => {
    const rendered = literalText(basketAwareLineRevenueSql(new Map()) as never);
    expect(rendered).not.toMatch(/case/i);
    expect(rendered).toMatch(/\*/);
  });

  it('renders a CASE/WHEN branch per override, falling back to the plain product', () => {
    const rendered = literalText(
      basketAwareLineRevenueSql(new Map([['item-1', 1596]])) as never,
    );
    expect(rendered).toMatch(/case/i);
    expect(rendered).toMatch(/when/i);
    expect(rendered).toMatch(/else/i);
  });

  it('renders one WHEN branch per distinct override entry', () => {
    const rendered = literalText(
      basketAwareLineRevenueSql(
        new Map([
          ['item-1', 100],
          ['item-2', 200],
        ]),
      ) as never,
    );
    expect(rendered.match(/when/gi)?.length).toBe(2);
  });
});
