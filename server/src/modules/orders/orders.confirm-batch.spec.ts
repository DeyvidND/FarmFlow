/**
 * Regression coverage for OrdersService.confirmBatch — the Плащания COD-review
 * drawer's "потвърди останалите" bulk action. Unlike confirmPending (date-scoped,
 * needs a deliverySlots join for the subselect), this is a plain id-set UPDATE:
 * tenant + status='pending' + `id IN (:ids)`, so no join is needed.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { orders } from '@fermeribg/db';
import { OrdersService } from './orders.service';

const dialect = new PgDialect();

/** Minimal db mock modelling the UPDATE chain, capturing the WHERE so the real
 *  drizzle condition can be rendered via PgDialect and asserted on. */
function buildDb(returningRows: { id: string }[]) {
  let updateWhere: unknown;

  const updateChain: any = {};
  updateChain.set = jest.fn(() => updateChain);
  updateChain.where = jest.fn((w: unknown) => {
    updateWhere = w;
    return updateChain;
  });
  updateChain.returning = jest.fn(() => Promise.resolve(returningRows));

  const db: any = {
    update: jest.fn(() => updateChain),
  };

  return {
    db,
    captured: () => ({ updateWhere }),
  };
}

function service(db: unknown, protocolEmail?: any): OrdersService {
  const cache: any = { del: jest.fn().mockResolvedValue(undefined) };
  // Only db + cache (+ optionally protocolEmail) are touched on the confirmBatch
  // path (drainConfirmEffects is fire-and-forget and swallows its own errors).
  return new OrdersService(
    db as any, {} as any, {} as any, {} as any, cache, {} as any, {} as any, {} as any,
    undefined, protocolEmail,
  );
}

describe('OrdersService.confirmBatch', () => {
  it('flips only pending rows among the given ids and returns {confirmed, failed, ids}', async () => {
    const { db, captured } = buildDb([{ id: 'o1' }, { id: 'o2' }]);
    const svc = service(db);

    const out = await svc.confirmBatch('tenant-1', ['o1', 'o2', 'o3']);

    expect(out).toEqual({ confirmed: 2, failed: 0, ids: ['o1', 'o2'] });
    const { updateWhere } = captured();
    const rendered = dialect.sqlToQuery(updateWhere as any);
    expect(rendered.sql.toLowerCase()).toContain(' in (');
    // tenantId, status='pending', then the id set — same base-condition shape
    // as confirmPending's undated path, plus the id-set filter.
    expect(rendered.params).toEqual(['tenant-1', 'pending', 'o1', 'o2', 'o3']);
  });

  it('is tenant-scoped — the WHERE bakes in tenantId so a foreign-tenant id can never come back confirmed', async () => {
    // The real UPDATE's WHERE (tenant + pending + id IN) is what keeps a
    // foreign-tenant id from being touched; this mock can't execute SQL, so it
    // simulates the DB-side filter by only returning the caller's own row —
    // the assertion proves tenantId/status ARE part of the rendered condition
    // driving that filter, not just the id list.
    const { db, captured } = buildDb([{ id: 'o1' }]);
    const svc = service(db);

    const out = await svc.confirmBatch('tenant-1', ['o1', 'foreign-o9']);

    expect(out).toEqual({ confirmed: 1, failed: 0, ids: ['o1'] });
    const { updateWhere } = captured();
    const rendered = dialect.sqlToQuery(updateWhere as any);
    expect(rendered.params[0]).toBe('tenant-1');
    expect(rendered.params[1]).toBe('pending');
    expect(rendered.params).toContain('foreign-o9');
  });

  it('never enqueues any email — the buyer already got their one mail at placement (2026-07-23)', async () => {
    const { db } = buildDb([{ id: 'o1' }, { id: 'o2' }]);
    const protocolEmail = { enqueueProtocolEmail: jest.fn(), sendProtocolEmail: jest.fn() };
    const svc = service(db, protocolEmail);

    const out = await svc.confirmBatch('tenant-1', ['o1', 'o2']);

    // `failed` survives in the response shape for API compatibility, pinned 0.
    expect(out).toEqual({ confirmed: 2, failed: 0, ids: ['o1', 'o2'] });
    expect(protocolEmail.enqueueProtocolEmail).not.toHaveBeenCalled();
    expect(protocolEmail.sendProtocolEmail).not.toHaveBeenCalled();
  });

  it('busts the payments cache only when at least one order was confirmed', async () => {
    const zero = buildDb([]);
    const zeroCache = { del: jest.fn().mockResolvedValue(undefined) };
    const svcZero = new OrdersService(
      zero.db as any, {} as any, {} as any, {} as any, zeroCache as any, {} as any, {} as any, {} as any,
    );
    const out = await svcZero.confirmBatch('tenant-1', ['o1']);
    expect(out).toEqual({ confirmed: 0, failed: 0, ids: [] });
    expect(zeroCache.del).not.toHaveBeenCalled();

    const some = buildDb([{ id: 'o1' }]);
    const someCache = { del: jest.fn().mockResolvedValue(undefined) };
    const svcSome = new OrdersService(
      some.db as any, {} as any, {} as any, {} as any, someCache as any, {} as any, {} as any, {} as any,
    );
    await svcSome.confirmBatch('tenant-1', ['o1']);
    expect(someCache.del).toHaveBeenCalled();
  });
});
