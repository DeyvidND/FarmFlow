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
});
