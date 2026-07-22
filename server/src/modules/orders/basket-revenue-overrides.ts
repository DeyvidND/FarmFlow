import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { type Database, orderItems, orders, products } from '@fermeribg/db';
import { allocateOrderRevenue, type OrderItemForAllocation } from './basket-revenue.util';

/**
 * Loads a basket-aware revenue OVERRIDE for every basket-child `order_items`
 * row belonging to this tenant, keyed by the row's own id — the SQL-aggregate
 * twin of {@link allocateOrderRevenue} for call sites that sum
 * `quantity × priceStotinki` across MANY rows in a single Postgres query
 * (stats/turnover trends, farmer-scoped payments) rather than looping one
 * order's items in JS (the commission ledger).
 *
 * Scoped to orders that actually CONTAIN a basket, found via the existing
 * `order_items_bundle_parent_idx` index — for the common case of a tenant
 * with no basket orders this is one fast, empty query, and every caller's
 * `lineRev` expression ({@link basketAwareLineRevenueSql}) falls back
 * unchanged to plain `quantity × priceStotinki`.
 *
 * Not date-scoped on purpose: basket rows are a small slice of `order_items`
 * regardless of the tenant's total order-history size (gated by the same
 * index), so it's cheaper and simpler to just load every basket child once
 * than to thread each caller's own date window through here too. Callers
 * that only need a handful of orders (e.g. one page of a paginated list) may
 * still want to scope further — see `orderIds` below.
 */
export async function loadBasketRevenueOverrides(
  db: Database,
  tenantId: string,
  orderIds?: string[],
): Promise<Map<string, number>> {
  const basketOrders = await db
    .selectDistinct({ orderId: orderItems.orderId })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orders.tenantId, tenantId),
        isNotNull(orderItems.bundleParentId),
        orderIds && orderIds.length > 0 ? inArray(orderItems.orderId, orderIds) : undefined,
      ),
    );
  const scopedOrderIds = basketOrders.map((r) => r.orderId).filter((id): id is string => !!id);
  if (scopedOrderIds.length === 0) return new Map();

  const rows: (OrderItemForAllocation & { orderId: string | null })[] = await db
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      bundleParentId: orderItems.bundleParentId,
      quantity: orderItems.quantity,
      priceStotinki: orderItems.priceStotinki,
      // The row's OWN product's live list price — used only to weight a
      // basket child's share against its siblings (see allocateOrderRevenue).
      memberPriceStotinki: products.priceStotinki,
    })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, scopedOrderIds));

  const byOrder = new Map<string, OrderItemForAllocation[]>();
  for (const r of rows) {
    if (!r.orderId) continue;
    const list = byOrder.get(r.orderId) ?? [];
    list.push(r);
    byOrder.set(r.orderId, list);
  }

  const overrides = new Map<string, number>();
  for (const items of byOrder.values()) {
    for (const [id, amount] of allocateOrderRevenue(items)) overrides.set(id, amount);
  }
  return overrides;
}

/**
 * The basket-aware twin of `orderItems.quantity × orderItems.priceStotinki`,
 * for embedding inside a SQL aggregate (`sum(...)`, `group by`, `filter`).
 * Every ordinary line keeps its plain value; a basket child's value comes
 * from `overrides` (built by {@link loadBasketRevenueOverrides}, which runs
 * the SAME {@link allocateOrderRevenue} rule the commission ledger uses).
 *
 * Renders to a bare multiplication (no `CASE` at all) when `overrides` is
 * empty — the common no-basket-in-scope path pays no extra query cost or
 * SQL complexity.
 *
 * CAVEAT: like the other raw-SQL FILTER-clause expressions already in this
 * codebase (see orders.service.ts `paymentsForFarmer`'s aggRows comment),
 * this expression's actual Postgres-side behaviour is NOT exercised by any
 * mocked service spec — those mocks return canned aggregate rows and never
 * evaluate real SQL. The arithmetic it mirrors is unit-tested exhaustively
 * in basket-revenue.util.spec.ts; `loadBasketRevenueOverrides` (the part
 * that decides WHICH override applies to which row) is unit-testable and
 * covered separately.
 */
export function basketAwareLineRevenueSql(overrides: Map<string, number>): SQL<number> {
  const plain = sql`(${orderItems.quantity} * ${orderItems.priceStotinki})`;
  if (overrides.size === 0) return sql<number>`${plain}`;
  const whenClauses = [...overrides.entries()].map(
    ([id, amount]) => sql`when ${orderItems.id} = ${id}::uuid then ${amount}::int`,
  );
  return sql<number>`(case ${sql.join(whenClauses, sql` `)} else ${plain} end)`;
}
