/**
 * Regression coverage for OrdersService.confirmPending's `date` scoping.
 *
 * Its only caller is the „Днес" (delivery-day) home's „Потвърди всички" button,
 * whose count (pipeline.new) comes from scheduledForDay (the DELIVERY day — a
 * slotted order's deliverySlots.date, falling back to createdAt only when
 * slotless). The old implementation filtered by orders.createdAt via
 * bgDayBounds(date) — the PLACED day — so the button could confirm the wrong
 * set of orders (or zero) while still reporting success. An UPDATE can't
 * leftJoin(deliverySlots) directly, so the delivery-day scoping has to go
 * through `id IN (subselect that joins deliverySlots)`.
 */
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { orders, deliverySlots } from '@fermeribg/db';
import { OrdersService } from './orders.service';

const dialect = new PgDialect();

/** Minimal db mock modelling both the (date-scoped) subselect chain and the
 *  outer UPDATE chain, capturing every argument so the real drizzle
 *  conditions can be rendered via PgDialect and asserted on. */
function buildDb(returningRows: { id: string }[]) {
  let subFrom: unknown;
  let subJoinTable: unknown;
  let subJoinOn: unknown;
  let subWhere: unknown;
  let updateWhere: unknown;

  const subChain: any = {};
  subChain.from = jest.fn((t: unknown) => {
    subFrom = t;
    return subChain;
  });
  subChain.leftJoin = jest.fn((t: unknown, on: unknown) => {
    subJoinTable = t;
    subJoinOn = on;
    return subChain;
  });
  subChain.where = jest.fn((w: unknown) => {
    subWhere = w;
    return subChain;
  });
  // Makes the chain usable as a drizzle subquery: `inArray` only special-cases
  // its `values` argument when it looks like an SQLWrapper (has getSQL()).
  // Resolved lazily (only when the outer WHERE is rendered), so it's fine that
  // subJoinOn/subWhere are captured after this function is defined.
  subChain.getSQL = () =>
    sql`(select ${orders.id} from ${orders} left join ${deliverySlots} on ${subJoinOn as any} where ${subWhere as any})`;

  const updateChain: any = {};
  updateChain.set = jest.fn(() => updateChain);
  updateChain.where = jest.fn((w: unknown) => {
    updateWhere = w;
    return updateChain;
  });
  updateChain.returning = jest.fn(() => Promise.resolve(returningRows));

  const db: any = {
    select: jest.fn(() => subChain),
    update: jest.fn(() => updateChain),
  };

  return {
    db,
    captured: () => ({ subFrom, subJoinTable, subJoinOn, subWhere, updateWhere }),
  };
}

function service(db: unknown): OrdersService {
  const cache: any = { del: jest.fn().mockResolvedValue(undefined) };
  // Only db + cache are touched on the confirmPending path (drainConfirmEffects
  // is fire-and-forget and swallows its own errors internally).
  return new OrdersService(db as any, {} as any, {} as any, {} as any, cache, {} as any, {} as any, {} as any);
}

describe('OrdersService.confirmPending', () => {
  it('without a date, confirms every pending order for the tenant — no subselect', async () => {
    const { db, captured } = buildDb([{ id: 'o1' }]);
    const svc = service(db);

    const out = await svc.confirmPending('tenant-1');

    expect(out).toEqual({ confirmed: 1 });
    expect(db.select).not.toHaveBeenCalled();
    const { updateWhere } = captured();
    const rendered = dialect.sqlToQuery(updateWhere as any);
    expect(rendered.sql.toLowerCase()).not.toContain(' in (');
    expect(rendered.params).toEqual(['tenant-1', 'pending']);
  });

  it('with a date, scopes the UPDATE to orders scheduled for that DELIVERY day (slot join), not orders.createdAt', async () => {
    const { db, captured } = buildDb([{ id: 'o1' }, { id: 'o2' }]);
    const svc = service(db);

    const out = await svc.confirmPending('tenant-1', '2026-07-20');

    expect(out).toEqual({ confirmed: 2 });

    // The subselect was issued, selecting only ids.
    expect(db.select).toHaveBeenCalledWith({ id: orders.id });
    const { subFrom, subJoinTable, subJoinOn, subWhere, updateWhere } = captured();
    expect(subFrom).toBe(orders);
    expect(subJoinTable).toBe(deliverySlots);

    // The join condition ties deliverySlots.id to orders.slotId (required so
    // deliverySlots.date is available for the delivery-day filter).
    const join = dialect.sqlToQuery(subJoinOn as any);
    expect(join.sql).toContain('"delivery_slots"."id"');
    expect(join.sql).toContain('"orders"."slot_id"');

    // The subselect's WHERE scopes tenant + pending + the DELIVERY day via
    // scheduledForDay: a slotted order matches on deliverySlots.date (the
    // fix), with orders.created_at only as the documented slotless fallback
    // (isNull(orders.slotId) branch) — not the sole/primary filter as before.
    const subq = dialect.sqlToQuery(subWhere as any);
    expect(subq.params).toEqual(expect.arrayContaining(['tenant-1', 'pending', '2026-07-20']));
    expect(subq.sql).toContain('"delivery_slots"."date" = $3');
    expect(subq.sql).toContain('"orders"."slot_id" is null');

    // The outer UPDATE filters `id IN (subselect)` against that subselect, plus
    // the same tenant/pending base conditions on the orders row being updated
    // — the fix's core shape: `"orders"."id" in (select ... where scheduledForDay(...))`.
    const upd = dialect.sqlToQuery(updateWhere as any);
    expect(upd.sql).toContain('"orders"."id" in (');
    expect(upd.sql).toContain('select "orders"."id" from "orders" left join "delivery_slots"');
    expect(upd.params).toEqual(expect.arrayContaining(['tenant-1', 'pending']));
  });

  it('busts the payments cache only when at least one order was confirmed', async () => {
    const zero = buildDb([]);
    const zeroCache = { del: jest.fn().mockResolvedValue(undefined) };
    const svcZero = new OrdersService(zero.db as any, {} as any, {} as any, {} as any, zeroCache as any, {} as any, {} as any, {} as any);
    await svcZero.confirmPending('tenant-1');
    expect(zeroCache.del).not.toHaveBeenCalled();

    const some = buildDb([{ id: 'o1' }]);
    const someCache = { del: jest.fn().mockResolvedValue(undefined) };
    const svcSome = new OrdersService(some.db as any, {} as any, {} as any, {} as any, someCache as any, {} as any, {} as any, {} as any);
    await svcSome.confirmPending('tenant-1');
    expect(someCache.del).toHaveBeenCalled();
  });
});
