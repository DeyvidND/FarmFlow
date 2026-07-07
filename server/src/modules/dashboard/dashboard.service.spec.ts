import { DashboardService } from './dashboard.service';

/**
 * summary() — the farmer's home tile. No spec constructed this service before, yet
 * it derives the numbers shown front-and-centre: today-vs-yesterday delta, product
 * turnover with delivery fees split out (max(0, total − lines)), the next free
 * slot, and the subscription banner gate.
 *
 * Mock: the five reads run under one Promise.all, so a shared FIFO would be order-
 * fragile. Instead each `select(projection)` starts an independent chain that
 * resolves by its projection's distinct keys — no inter-query ordering assumption.
 */
function makeDb(r: {
  agg: unknown[];
  prod: unknown[];
  yesterday: unknown[];
  tenant: unknown[];
  slots: unknown[];
}) {
  const pick = (proj: Record<string, unknown>): unknown[] => {
    const keys = Object.keys(proj ?? {});
    if (keys.includes('orderCount')) return r.agg;
    if (keys.includes('revenueStotinki')) return r.prod;
    if (keys.includes('yesterday')) return r.yesterday;
    if (keys.includes('status')) return r.tenant;
    if (keys.includes('timeFrom')) return r.slots;
    return [];
  };

  const chain = (proj: Record<string, unknown>) => {
    const b: any = {};
    const passthrough = ['from', 'where', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy'];
    for (const m of passthrough) b[m] = jest.fn(() => b);
    b.limit = jest.fn(async () => pick(proj));
    // Queries with no `.limit()` are awaited directly → resolve via then.
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(pick(proj)).then(res, rej);
    return b;
  };

  return { select: jest.fn((proj: Record<string, unknown>) => chain(proj)) };
}

const svc = (db: unknown) => new DashboardService(db as never);

describe('DashboardService.summary', () => {
  it('derives delta, splits delivery from turnover, and finds the next free slot', async () => {
    const db = makeDb({
      agg: [{ orderCount: 5, totalStotinki: 12000, pendingCount: 2 }],
      prod: [{ revenueStotinki: 9000 }],
      yesterday: [{ yesterday: 3 }],
      tenant: [{ status: 'active' }],
      slots: [
        { id: 's1', timeFrom: '09:00', timeTo: '10:00', booked: 1, capacity: 1 },
        { id: 's2', timeFrom: '10:00', timeTo: '11:00', booked: 0, capacity: 1 },
      ],
    });

    const out = await svc(db).summary('t1', '2026-06-30');

    expect(out.date).toBe('2026-06-30');
    expect(out.orderCount).toBe(5);
    expect(out.orderDelta).toBe(2); // 5 − 3
    expect(out.revenueStotinki).toBe(9000);
    expect(out.deliveryRevenueStotinki).toBe(3000); // 12000 − 9000
    expect(out.pendingCount).toBe(2);
    expect(out.nextSlot).toMatchObject({ id: 's2', booked: 0 });
    expect(out.slots).toHaveLength(2);
    expect(out.subscriptionActive).toBe(true);
  });

  it('clamps delivery revenue at 0 and reports no free slot / inactive subscription', async () => {
    const db = makeDb({
      // total < product lines (shouldn't happen, but the clamp must hold).
      agg: [{ orderCount: 1, totalStotinki: 500, pendingCount: 0 }],
      prod: [{ revenueStotinki: 800 }],
      yesterday: [{ yesterday: 4 }],
      tenant: [{ status: 'inactive' }],
      slots: [{ id: 's1', timeFrom: '09:00', timeTo: '10:00', booked: 2, capacity: 1 }],
    });

    const out = await svc(db).summary('t1', '2026-06-30');

    expect(out.deliveryRevenueStotinki).toBe(0);
    expect(out.orderDelta).toBe(-3); // 1 − 4
    expect(out.nextSlot).toBeNull();
    expect(out.subscriptionActive).toBe(false);
  });

  it('defaults to subscription active when the tenant row is absent (only explicit "inactive" gates off)', async () => {
    const db = makeDb({
      agg: [{ orderCount: 0, totalStotinki: 0, pendingCount: 0 }],
      prod: [{ revenueStotinki: 0 }],
      yesterday: [{ yesterday: 0 }],
      tenant: [], // no row → undefined status → not 'inactive'
      slots: [],
    });

    const out = await svc(db).summary('t1', '2026-06-30');

    expect(out.subscriptionActive).toBe(true);
    expect(out.nextSlot).toBeNull();
    expect(out.slots).toEqual([]);
  });

  it('a capacity-2 slot with 1 booked is not full and is still the next free slot', async () => {
    const db = makeDb({
      agg: [{ orderCount: 1, totalStotinki: 500, pendingCount: 0 }],
      prod: [{ revenueStotinki: 500 }],
      yesterday: [{ yesterday: 0 }],
      tenant: [{ status: 'active' }],
      slots: [{ id: 's1', timeFrom: '09:00', timeTo: '10:00', booked: 1, capacity: 2 }],
    });

    const out = await svc(db).summary('t1', '2026-06-30');

    expect(out.nextSlot).toMatchObject({ id: 's1', booked: 1, capacity: 2 });
    expect(out.slots[0].capacity).toBe(2);
  });
});
