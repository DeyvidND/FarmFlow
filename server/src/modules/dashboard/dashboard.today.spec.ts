import { DashboardService } from './dashboard.service';

/** todaySummary runs ~8 independent reads under one Promise.all; route each by its
 *  projection's distinctive key (no inter-query ordering assumption). */
function makeDb(r: Partial<{
  pipeline: unknown[]; cod: unknown[]; fulfilled: unknown[]; signed: unknown[];
  farmerLegs: unknown[]; customerLegs: unknown[]; couriers: unknown[]; slots: unknown[];
}> = {}) {
  const pick = (proj: Record<string, unknown>): unknown[] => {
    const k = Object.keys(proj ?? {});
    if (k.includes('status')) return r.pipeline ?? [];
    if (k.includes('toCollectStotinki')) return r.cod ?? [];
    if (k.includes('orderId')) return r.fulfilled ?? [];
    if (k.includes('signed')) return r.signed ?? [];
    if (k.includes('farmerId')) return r.farmerLegs ?? [];
    if (k.includes('customerLegs')) return r.customerLegs ?? [];
    if (k.includes('legIndex')) return r.couriers ?? [];
    if (k.includes('timeFrom')) return r.slots ?? [];
    return [];
  };
  const chain = (proj: Record<string, unknown>) => {
    const b: any = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy', 'having']) b[m] = jest.fn(() => b);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(pick(proj)).then(res, rej);
    return b;
  };
  return { select: jest.fn((proj: Record<string, unknown>) => chain(proj)) };
}
const svc = (db: unknown) => new DashboardService(db as never);

describe('DashboardService.todaySummary', () => {
  it('returns a fully-zeroed cockpit when nothing is scheduled', async () => {
    const out = await svc(makeDb()).todaySummary('t1', '2026-07-20');
    expect(out).toEqual({
      date: '2026-07-20',
      pipeline: { new: 0, confirmed: 0, preparing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, total: 0 },
      prep: { ordersToPrep: 0, fulfilled: 0 },
      route: { stops: 0, delivered: 0, pending: 0, couriers: 0 },
      protocols: { total: 0, signed: 0, pending: 0 },
      cod: { toCollectStotinki: 0, toCollectCount: 0, collectedStotinki: 0, collectedCount: 0 },
      revenueStotinki: 0,
      slots: [],
    });
  });

  it('buckets pipeline by status, sums non-cancelled revenue, splits route from address orders', async () => {
    const db = makeDb({
      pipeline: [
        { status: 'pending',          count: 3, totalStotinki: 3000, addr: 2 },
        { status: 'confirmed',        count: 4, totalStotinki: 8000, addr: 3 },
        { status: 'preparing',        count: 1, totalStotinki: 2000, addr: 1 },
        { status: 'out_for_delivery', count: 2, totalStotinki: 5000, addr: 2 },
        { status: 'delivered',        count: 5, totalStotinki: 9000, addr: 4 },
        { status: 'cancelled',        count: 1, totalStotinki: 1000, addr: 1 },
      ],
      couriers: [{ legIndex: 0 }, { legIndex: 1 }],
    });
    const out = await svc(db).todaySummary('t1', '2026-07-20');
    expect(out.pipeline).toEqual({ new: 3, confirmed: 4, preparing: 1, outForDelivery: 2, delivered: 5, cancelled: 1, total: 15 });
    expect(out.revenueStotinki).toBe(27000); // 3000+8000+2000+5000+9000 (cancelled excluded)
    expect(out.prep.ordersToPrep).toBe(5);   // confirmed 4 + preparing 1
    // route stops = address orders in active statuses (2+3+1+2+4=12); delivered addr = 4
    expect(out.route).toEqual({ stops: 12, delivered: 4, pending: 8, couriers: 2 });
  });

  it('splits COD into to-collect vs collected and counts fully-fulfilled orders', async () => {
    const db = makeDb({
      pipeline: [{ status: 'confirmed', count: 2, totalStotinki: 4000, addr: 2 }],
      cod: [{ toCollectStotinki: 4000, toCollectCount: 2, collectedStotinki: 1500, collectedCount: 1 }],
      fulfilled: [{ orderId: 'o1' }, { orderId: 'o2' }], // 2 orders fully prepared
    });
    const out = await svc(db).todaySummary('t1', '2026-07-20');
    expect(out.cod).toEqual({ toCollectStotinki: 4000, toCollectCount: 2, collectedStotinki: 1500, collectedCount: 1 });
    expect(out.prep.fulfilled).toBe(2);
  });

  it('counts protocols: farmer-legs + customer-legs expected, persisted signed, clamped pending', async () => {
    const db = makeDb({
      pipeline: [{ status: 'confirmed', count: 3, totalStotinki: 6000, addr: 2 }],
      signed: [{ signed: 1 }],
      farmerLegs: [{ farmerId: 'f1', slotId: 's1' }, { farmerId: 'f2', slotId: 's1' }], // 2 farmer legs
      customerLegs: [{ customerLegs: 2 }], // 2 address deliveries
    });
    const out = await svc(db).todaySummary('t1', '2026-07-20');
    expect(out.protocols).toEqual({ total: 4, signed: 1, pending: 3 }); // 2+2 expected, 1 signed
  });

  it('maps slots for the day', async () => {
    const db = makeDb({
      slots: [
        { id: 's1', timeFrom: '09:00', timeTo: '10:00', capacity: 3, booked: 1 },
        { id: 's2', timeFrom: '10:00', timeTo: '11:00', capacity: 2, booked: 2 },
      ],
    });
    const out = await svc(db).todaySummary('t1', '2026-07-20');
    expect(out.slots).toEqual([
      { id: 's1', timeFrom: '09:00', timeTo: '10:00', capacity: 3, booked: 1 },
      { id: 's2', timeFrom: '10:00', timeTo: '11:00', capacity: 2, booked: 2 },
    ]);
  });

  it('scopes the pipeline query to the tenant (filter is modelled, not ignored)', async () => {
    const { PgDialect } = require('drizzle-orm/pg-core');
    let captured: any;
    const base = makeDb({});
    const realSelect = base.select;
    base.select = jest.fn((proj: any) => {
      const chain = realSelect(proj);
      if (Object.keys(proj).includes('status')) {
        const realWhere = chain.where;
        chain.where = jest.fn((cond: any) => { captured = cond; return realWhere(cond); });
      }
      return chain;
    });
    await svc(base).todaySummary('tenant-XYZ', '2026-07-20');
    const { params } = new PgDialect().sqlToQuery(captured);
    expect(params).toContain('tenant-XYZ'); // tenant scope present in the WHERE
  });
});
