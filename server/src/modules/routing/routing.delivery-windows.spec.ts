import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { RoutingService } from './routing.service';

// ---------------------------------------------------------------------------
// Shared mocked-db chain, mirroring routing.courier-default.spec.ts /
// routing.adversarial.spec.ts's style: successive select() calls consume the
// next pre-loaded result; the chain itself is "thenable" so a query that never
// calls .orderBy()/.limit() (e.g. the order-items lookup) still awaits fine.
// update() is tracked so tests can assert HOW MANY orders were written,
// without needing to inspect the drizzle `eq()`/`and()` where-expression
// internals.
// ---------------------------------------------------------------------------
function makeDb(selectResults: any[][]) {
  const results = [...selectResults];
  let updateCount = 0;
  let lastSet: any = null;
  let lastWhere: any = null;
  const db = {
    select: () => {
      const result = results.length ? results.shift()! : [];
      const chain: any = {
        from: () => chain,
        leftJoin: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => Promise.resolve(result),
        limit: () => Promise.resolve(result),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
    update: () => ({
      set: (v: any) => {
        updateCount++;
        lastSet = v;
        return {
          where: (w: any) => {
            lastWhere = w;
            return Promise.resolve(undefined);
          },
        };
      },
    }),
    get __updateCount() {
      return updateCount;
    },
    get __lastSet() {
      return lastSet;
    },
    get __lastWhere() {
      return lastWhere;
    },
  } as any;
  return db;
}

const geoOrder = (
  id: string,
  lat: number,
  lng: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  customer: null,
  phone: null,
  email: 'client@test.bg',
  address: `адрес ${id}`,
  note: null,
  lat: String(lat),
  lng: String(lng),
  ...extra,
});

// Task A3 — no per-day assignment board rows in these tests; getRoute's
// leg-count precedence check is a no-op (falls through to the ?couriers=
// dropdown / saved default, which these tests exercise directly).
const noAssignments = () => ({ getAssignmentsForDay: jest.fn().mockResolvedValue([]) }) as any;

// ─── (a) persisted manual order (route_seq) wins over the optimizer ────────
describe('RoutingService.getRoute — route_seq honoured over re-optimization', () => {
  it('sorts by route_seq even when the maps-optimize mock would reorder differently', async () => {
    // A "hostile" optimizer that reverses whatever it's given — if the service
    // ever called it for this group, the order would come back reversed
    // instead of the persisted sequence.
    const route = jest.fn(async (_o: any, pts: any[]) => ({
      order: pts.map((_: any, i: number) => pts.length - 1 - i),
      distanceM: 1000,
      durationS: 600,
      polyline: 'g',
    }));
    const maps = {
      route,
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 900, durationS: 600, polyline: 'r' }),
      geocode: jest.fn(),
    } as any;

    const TENANT = {
      farmAddress: 'Ферма',
      farmLat: '43.17',
      farmLng: '27.84',
      settings: { routing: {} },
    };
    // A (seq 2), B (seq 0), C (seq 1) — persisted visit order is B, C, A.
    const rows = [
      geoOrder('A', 43.24, 27.9, { routeSeq: 2 }),
      geoOrder('B', 43.2, 27.95, { routeSeq: 0 }),
      geoOrder('C', 43.16, 27.9, { routeSeq: 1 }),
    ];
    const db = makeDb([[TENANT], rows, []]);
    const svc = new RoutingService(db, maps, {} as any, {} as any, noAssignments());

    const result = await svc.getRoute('t1', '2026-07-07');

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].stops.map((s) => s.id)).toEqual(['B', 'C', 'A']);
    // preserveOrder skips the Google optimizer entirely for a sequenced group.
    expect(route).not.toHaveBeenCalled();
  });

  it('leaves an un-sequenced group to the normal optimizer', async () => {
    const route = jest.fn(async (_o: any, pts: any[]) => ({
      order: pts.map((_: any, i: number) => i),
      distanceM: 1000,
      durationS: 600,
      polyline: 'g',
    }));
    const maps = {
      route,
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 900, durationS: 600, polyline: 'r' }),
      geocode: jest.fn(),
    } as any;
    const TENANT = {
      farmAddress: 'Ферма',
      farmLat: '43.17',
      farmLng: '27.84',
      settings: { routing: {} },
    };
    const rows = [geoOrder('A', 43.24, 27.9), geoOrder('B', 43.2, 27.95)];
    const db = makeDb([[TENANT], rows, []]);
    const svc = new RoutingService(db, maps, {} as any, {} as any, noAssignments());

    await svc.getRoute('t1', '2026-07-07');

    expect(route).toHaveBeenCalled();
  });
});

// ─── (b) regenerate must not clobber an already-SENT, unchanged window ──────
describe('RoutingService.generateDeliveryWindows — sent windows are not clobbered', () => {
  // A deterministic single-stop leg: the real per-leg mock gives a 10-min drive to
  // the stop → window 09:00–09:35 (09:00 + 10 min floored to the 15-min grid, plus
  // the 35-min smart width). Regenerating recomputes the SAME window.
  const sentTenant = {
    farmAddress: 'Ферма',
    farmLat: '43.0',
    farmLng: '23.0',
    settings: { routing: { dayStartHour: 9, serviceMin: 0 } },
  };
  const tenMinLegsMaps = () =>
    ({
      route: jest.fn().mockResolvedValue({ order: [0], distanceM: 5000, durationS: 600, polyline: 'g' }),
      // legs length always matches the point sequence (works whether or not the leg
      // has a return leg); each leg is a flat 10 minutes.
      routeFixed: jest.fn((pts: any[]) =>
        Promise.resolve({
          distanceM: 5000 * (pts.length - 1),
          durationS: 600 * (pts.length - 1),
          polyline: 'g',
          legs: pts.slice(1).map(() => ({ distanceM: 5000, durationS: 600 })),
        }),
      ),
      geocode: jest.fn(),
    }) as any;

  it('leaves a sent window alone when it recomputes to the SAME time (no clobber)', async () => {
    const row = geoOrder('X', 43.01, 23.0, {
      windowStatus: 'sent',
      windowStart: '09:00',
      windowEnd: '09:35',
    });
    const db = makeDb([[sentTenant], [row], [], [sentTenant]]);
    const svc = new RoutingService(db, tenMinLegsMaps(), {} as any, {} as any, noAssignments());

    const proposal = await svc.generateDeliveryWindows('t1', '2026-07-07');

    expect(proposal.couriers[0].stops[0].windowStart).toBe('09:00');
    expect(proposal.couriers[0].stops[0].windowEnd).toBe('09:35');
    expect(db.__updateCount).toBe(0); // sent + unchanged → not rewritten
  });

  it('rewrites a sent window whose recomputed time changed (back to draft)', async () => {
    const row = geoOrder('Y', 43.01, 23.0, {
      windowStatus: 'sent',
      windowStart: '08:00',
      windowEnd: '09:00',
    });
    const db = makeDb([[sentTenant], [row], [], [sentTenant]]);
    const svc = new RoutingService(db, tenMinLegsMaps(), {} as any, {} as any, noAssignments());

    const proposal = await svc.generateDeliveryWindows('t1', '2026-07-07');

    expect(proposal.couriers[0].stops[0].windowStart).toBe('09:00'); // recomputed, differs from 08:00
    expect(db.__updateCount).toBe(1);
  });
});

// ─── (b2) many changed windows persist in ONE set-based UPDATE, not N ───────────
describe('RoutingService.generateDeliveryWindows — set-based persist', () => {
  it('writes every changed window in a single CASE UPDATE binding each id + window', async () => {
    const TENANT = { farmAddress: null, farmLat: null, farmLng: null, settings: { routing: {} } };
    // Two orders with no existing window → both change → both must be persisted.
    const rowA = geoOrder('order-a', 43.0, 23.0);
    const rowB = geoOrder('order-b', 43.01, 23.01);
    const db = makeDb([[TENANT], [rowA, rowB], [], [TENANT]]);
    const maps = { route: jest.fn(), routeFixed: jest.fn(), geocode: jest.fn() } as any;
    const svc = new RoutingService(db, maps, {} as any, {} as any, noAssignments());

    await svc.generateDeliveryWindows('t1', '2026-07-07');

    // ONE UPDATE statement for BOTH changed orders (was one per order).
    expect(db.__updateCount).toBe(1);
    expect(db.__lastSet.deliveryWindowStatus).toBe('draft');

    const dialect = new PgDialect();
    const startCase = dialect.sqlToQuery(db.__lastSet.deliveryWindowStart as SQL);
    const endCase = dialect.sqlToQuery(db.__lastSet.deliveryWindowEnd as SQL);
    const where = dialect.sqlToQuery(db.__lastWhere as SQL);
    expect(startCase.sql.toLowerCase()).toContain('case');
    // The THEN values MUST be cast to ::time — a bare text bind param makes the CASE
    // resolve to text and Postgres rejects the assignment to the `time` column (the
    // prod 500 on POST /orders/route/windows/generate). Lock the cast in.
    expect(startCase.sql.toLowerCase()).toContain('::time');
    expect(endCase.sql.toLowerCase()).toContain('::time');
    // This test is about the set-based binding — every changed id paired with its own
    // HH:MM value in one statement. The exact times are the timing specs' business
    // (windows are smart-width now, not a fixed 09:00–10:00 slot), so assert shape.
    const hhmm = (p: unknown) => typeof p === 'string' && /^\d{2}:\d{2}$/.test(p);
    expect(startCase.params).toEqual(expect.arrayContaining(['order-a', 'order-b', '09:00']));
    expect(endCase.params).toEqual(expect.arrayContaining(['order-a', 'order-b']));
    expect(startCase.params.filter(hhmm)).toHaveLength(2);
    expect(endCase.params.filter(hhmm)).toHaveLength(2);
    // WHERE id IN (both) AND tenant-scoped.
    expect(where.params).toEqual(expect.arrayContaining(['order-a', 'order-b', 't1']));
  });
});

// ─── (c) return-leg no longer excluded from the per-stop time-share denominator ─
describe('RoutingService.generateDeliveryWindows — return-leg timing fix', () => {
  it("does not inflate the only stop's window with the full round-trip drive time", async () => {
    const TENANT = {
      farmAddress: 'Ферма',
      farmLat: '43.0',
      farmLng: '23.0',
      settings: { routing: { dayStartHour: 9, slotSizeMin: 15, serviceMin: 0 } },
    };
    const row = geoOrder('S1', 43.01, 23.0);
    const db = makeDb([[TENANT], [row], [], [TENANT]]);
    // A single-stop, non-reordered, 'home' (round-trip) leg: Google's own
    // numbers (20 min total) are reused as-is (precomputedTotal), so driveMin
    // is deterministic regardless of the actual haversine distances chosen.
    const maps = {
      route: jest.fn().mockResolvedValue({ order: [0], distanceM: 5000, durationS: 1200, polyline: 'g' }),
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 5000, durationS: 1200, polyline: 'g' }),
      geocode: jest.fn(),
    } as any;
    const svc = new RoutingService(db, maps, {} as any, {} as any, noAssignments());

    const proposal = await svc.generateDeliveryWindows('t1', '2026-07-07');

    // Origin→stop distance D and stop→home(=origin) distance are identical
    // (same two points, symmetric haversine) — so a route WITH a return leg
    // (endMode 'home', the default) splits the 20-minute measured duration
    // 50/50: 10 minutes to reach the only stop, not the full 20 the pre-fix
    // ratio (cumDist/onewayDist = 1.0) would have given it. 9:00 + 10min,
    // floored to the 15-min grid, is still the 09:00–09:15 slot; the bugged
    // (inflated, +20min) version would land a 15-min grid slot later (09:15 start).
    // The END is the smart width (30 min + delay-risk growth), not the old fixed slot.
    expect(proposal.couriers[0].stops[0].windowStart).toBe('09:00');
    expect(proposal.couriers[0].stops[0].windowEnd).toBe('09:35');
  });
});

describe('RoutingService.generateDeliveryWindows — start hour override', () => {
  const TENANT = {
    farmAddress: 'Ферма',
    farmLat: '43.0',
    farmLng: '23.0',
    // Saved default is 09:00; the explicit startHour below must win over it.
    settings: { routing: { dayStartHour: 9, slotSizeMin: 15, serviceMin: 0 } },
  };
  const maps = {
    route: jest.fn().mockResolvedValue({ order: [0], distanceM: 5000, durationS: 1200, polyline: 'g' }),
    routeFixed: jest.fn().mockResolvedValue({ distanceM: 5000, durationS: 1200, polyline: 'g' }),
    geocode: jest.fn(),
  } as any;

  it('an explicit startHour shifts the first stop window off the saved dayStartHour default', async () => {
    const row = geoOrder('S1', 43.01, 23.0);
    const db = makeDb([[TENANT], [row], [], [TENANT]]);
    const svc = new RoutingService(db, maps, {} as any, {} as any, noAssignments());

    // Same single 'home' round-trip leg as the return-leg test above: the only
    // stop lands ~10min after the start hour, floored to the 15-min grid. With
    // startHour=14 that's 14:00–14:15, not the 09:00 the saved default gives.
    const proposal = await svc.generateDeliveryWindows('t1', '2026-07-07', undefined, undefined, 14);

    expect(proposal.couriers[0].stops[0].windowStart).toBe('14:00');
    expect(proposal.couriers[0].stops[0].windowEnd).toBe('14:35');
  });

  it('startHour 0 (midnight) is honoured, not mistaken for "unset"', async () => {
    const row = geoOrder('S1', 43.01, 23.0);
    const db = makeDb([[TENANT], [row], [], [TENANT]]);
    const svc = new RoutingService(db, maps, {} as any, {} as any, noAssignments());

    const proposal = await svc.generateDeliveryWindows('t1', '2026-07-07', undefined, undefined, 0);

    expect(proposal.couriers[0].stops[0].windowStart).toBe('00:00');
    expect(proposal.couriers[0].stops[0].windowEnd).toBe('00:35');
  });

  it('omitting startHour falls back to the saved dayStartHour', async () => {
    const row = geoOrder('S1', 43.01, 23.0);
    const db = makeDb([[TENANT], [row], [], [TENANT]]);
    const svc = new RoutingService(db, maps, {} as any, {} as any, noAssignments());

    const proposal = await svc.generateDeliveryWindows('t1', '2026-07-07');

    expect(proposal.couriers[0].stops[0].windowStart).toBe('09:00');
  });
});

// ─── (d) notify continues past one send failure ────────────────────────────
describe('RoutingService.notifyDeliveryWindows — partial-failure resilience', () => {
  it('continues past a failed send, reports it, and does not mark that order sent', async () => {
    const rows = [
      { id: 'o1', email: 'a@test.bg', windowStart: '09:00', windowEnd: '10:00' },
      { id: 'o2', email: 'b@test.bg', windowStart: '10:00', windowEnd: '11:00' },
    ];
    // Record every update's SET payload so we can distinguish claim / mark-sent /
    // release. Every claim wins the race in this single-run test.
    const sets: Record<string, unknown>[] = [];
    const db = {
      select: () => {
        const chain: any = {
          from: () => chain,
          leftJoin: () => chain,
          where: () => Promise.resolve(rows),
          then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      },
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          sets.push(vals);
          return {
            where: () => ({
              // The claim chains .returning(); a won claim returns one row.
              returning: () => Promise.resolve([{ id: 'claimed' }]),
              // mark-sent / release just await the where().
              then: (resolve: any, reject: any) => Promise.resolve(undefined).then(resolve, reject),
            }),
          };
        },
      }),
    } as any;
    const orderEmail = {
      sendDeliveryWindow: jest
        .fn()
        .mockRejectedValueOnce(new Error('smtp down'))
        .mockResolvedValueOnce(undefined),
    };
    const svc = new RoutingService(db, {} as any, {} as any, orderEmail as any, {} as any);

    const result = await svc.notifyDeliveryWindows('t1', '2026-07-07');

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 1, total: 2, date: '2026-07-07' });
    expect(orderEmail.sendDeliveryWindow).toHaveBeenCalledTimes(2);
    // Exactly one order was marked 'sent' (the successful o2).
    expect(sets.filter((s) => s.deliveryWindowStatus === 'sent')).toHaveLength(1);
    // The failed order (o1) had its claim released (notifiedAt → null) so a later
    // run can retry it — never left claimed-but-unsent.
    expect(sets.filter((s) => s.deliveryWindowNotifiedAt === null)).toHaveLength(1);
    // Two claims (one per row), each stamping notifiedAt with a Date.
    expect(sets.filter((s) => s.deliveryWindowNotifiedAt instanceof Date)).toHaveLength(2);
  });

  it('skips a row it cannot claim (a concurrent run already owns it)', async () => {
    const rows = [{ id: 'o1', email: 'a@test.bg', windowStart: '09:00', windowEnd: '10:00' }];
    const db = {
      select: () => {
        const chain: any = {
          from: () => chain,
          leftJoin: () => chain,
          where: () => Promise.resolve(rows),
          then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      },
      update: () => ({
        set: () => ({
          where: () => ({
            // Lost the race — the compare-and-set updated no row.
            returning: () => Promise.resolve([]),
            then: (resolve: any, reject: any) => Promise.resolve(undefined).then(resolve, reject),
          }),
        }),
      }),
    } as any;
    const orderEmail = { sendDeliveryWindow: jest.fn() };
    const svc = new RoutingService(db, {} as any, {} as any, orderEmail as any, {} as any);

    const result = await svc.notifyDeliveryWindows('t1', '2026-07-07');

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, total: 1, date: '2026-07-07' });
    // Never sent — the row was already claimed elsewhere.
    expect(orderEmail.sendDeliveryWindow).not.toHaveBeenCalled();
  });
});

// ─── (e) approve joins delivery_slots for the scheduledForDay eligibility ────
describe('RoutingService.approveDeliveryWindows — joins delivery_slots', () => {
  it('leftJoins delivery_slots in the eligibility subselect and returns the approved count', async () => {
    // An UPDATE can't .leftJoin, so approve builds a self-contained subselect that
    // joins delivery_slots (scheduledForDay references delivery_slots.date) and
    // updates by id. Without the join, Postgres throws "missing FROM-clause entry
    // for table delivery_slots" — the mock can't reproduce that SQL error, so we
    // assert the join is present on the subselect chain instead.
    let leftJoinCalled = false;
    const db = {
      select: () => {
        const chain: any = {
          from: () => chain,
          leftJoin: () => {
            leftJoinCalled = true;
            return chain;
          },
          // The subselect is passed to inArray(), never awaited on its own.
          where: () => chain,
        };
        return chain;
      },
      update: () => ({
        set: () => ({
          where: () => ({
            // Two rows matched → approved: 2.
            returning: () => Promise.resolve([{ id: 'o1' }, { id: 'o2' }]),
          }),
        }),
      }),
    } as any;
    const svc = new RoutingService(db, {} as any, {} as any, {} as any, {} as any);

    const result = await svc.approveDeliveryWindows('t1', '2026-07-07');

    expect(result).toEqual({ approved: 2, date: '2026-07-07' });
    // The eligibility subselect MUST join delivery_slots per scheduledForDay's contract.
    expect(leftJoinCalled).toBe(true);
  });
});

// ─── cascade shift: nudge one stop, slide the rest of its leg (task #13, WP9) ──
describe('RoutingService.shiftDeliveryWindows — cascade', () => {
  // A db whose transaction runs the callback with a tx that RECORDS every UPDATE
  // .set() payload, so a test can assert exactly which stops were shifted and to
  // what — the shift is a per-stop UPDATE loop over one leg's tail.
  function makeShiftDb() {
    const sets: any[] = [];
    const tx = {
      update: () => ({
        set: (v: any) => {
          sets.push(v);
          return { where: () => Promise.resolve(undefined) };
        },
      }),
    };
    const db = { transaction: async (cb: any) => cb(tx) } as any;
    return { db, sets };
  }

  const svcWithRoute = (db: any, route: any) => {
    const svc = new RoutingService(db, {} as any, {} as any, {} as any, noAssignments());
    jest.spyOn(svc, 'getRoute').mockResolvedValue(route as any);
    return svc;
  };

  const win = (
    id: string,
    start: string | null,
    end: string | null,
    status: string | null = 'draft',
  ) => ({ id, deliveryWindowStart: start, deliveryWindowEnd: end, deliveryWindowStatus: status });

  const twoLegRoute = () => ({
    date: '2026-07-20',
    routes: [
      {
        courierIndex: 0,
        stops: [win('A', '10:00', '10:30'), win('B', '10:30', '11:00'), win('C', '11:00', '11:30')],
      },
      { courierIndex: 1, stops: [win('D', '09:00', '09:30'), win('E', '09:30', '10:00')] },
    ],
  });

  it('shifts the nudged stop + every later stop on its leg by the delta; earlier stops and other legs untouched', async () => {
    const { db, sets } = makeShiftDb();
    const svc = svcWithRoute(db, twoLegRoute());

    const res = await svc.shiftDeliveryWindows('t1', '2026-07-20', 'B', 5); // +5 from B

    expect(res).toEqual({ shifted: 2 }); // B and C only (A is earlier; D/E are another leg)
    expect(sets).toEqual([
      { deliveryWindowStart: '10:35', deliveryWindowEnd: '11:05', deliveryWindowStatus: 'draft' },
      { deliveryWindowStart: '11:05', deliveryWindowEnd: '11:35', deliveryWindowStatus: 'draft' },
    ]);
  });

  it('applies a negative delta too (pull the day earlier)', async () => {
    const { db, sets } = makeShiftDb();
    const svc = svcWithRoute(db, twoLegRoute());

    await svc.shiftDeliveryWindows('t1', '2026-07-20', 'A', -10); // whole leg 0 −10

    expect(sets.map((s) => s.deliveryWindowStart)).toEqual(['09:50', '10:20', '10:50']);
  });

  it('re-arms an approved/sent window to approved so a corrected time can be re-notified', async () => {
    const { db, sets } = makeShiftDb();
    const route = {
      date: '2026-07-20',
      routes: [
        { courierIndex: 0, stops: [win('A', '10:00', '10:30', 'sent'), win('B', '10:30', '11:00', 'approved')] },
      ],
    };
    const svc = svcWithRoute(db, route);

    await svc.shiftDeliveryWindows('t1', '2026-07-20', 'A', 10);

    expect(sets.map((s) => s.deliveryWindowStatus)).toEqual(['approved', 'approved']);
    expect(sets[0].deliveryWindowStart).toBe('10:10');
  });

  it('skips later stops that have no window yet', async () => {
    const { db, sets } = makeShiftDb();
    const route = {
      date: '2026-07-20',
      routes: [
        { courierIndex: 0, stops: [win('A', '10:00', '10:30'), win('B', null, null), win('C', '11:00', '11:30')] },
      ],
    };
    const svc = svcWithRoute(db, route);

    const res = await svc.shiftDeliveryWindows('t1', '2026-07-20', 'A', 5);

    expect(res.shifted).toBe(2); // A and C; B has no window to move
    expect(sets).toHaveLength(2);
  });

  it('rejects a zero or non-integer delta (before touching the route)', async () => {
    const { db } = makeShiftDb();
    const svc = svcWithRoute(db, twoLegRoute());

    await expect(svc.shiftDeliveryWindows('t1', '2026-07-20', 'A', 0)).rejects.toThrow(
      BadRequestException,
    );
    await expect(svc.shiftDeliveryWindows('t1', '2026-07-20', 'A', 1.5)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('404s when the stop is not on the route', async () => {
    const { db } = makeShiftDb();
    const svc = svcWithRoute(db, twoLegRoute());

    await expect(svc.shiftDeliveryWindows('t1', '2026-07-20', 'ZZZ', 5)).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ─── distance-from-previous + current-position seeding (task #13, WP5) ─────────
describe('RoutingService.generateDeliveryWindows — distance-from-previous', () => {
  const stop = (id: string, lat: number, lng: number) => ({
    id,
    customer: id,
    email: 'c@test.bg',
    lat,
    lng,
    deliveryWindowStart: null,
    deliveryWindowEnd: null,
    deliveryWindowStatus: null,
  });

  const routeFromFarm = () => ({
    date: '2026-07-20',
    origin: { lat: 43.17, lng: 27.84, address: 'Ферма' },
    routes: [
      {
        courierIndex: 0,
        name: null,
        endMode: 'last',
        endLat: null,
        endLng: null,
        totalDurationS: 1800,
        totalDistanceM: 20000,
        stops: [stop('A', 43.2, 27.9), stop('B', 43.1, 27.95)],
      },
    ],
  });

  // Empty-select db (farmersByOrder finds no producers) with a no-op update.
  const windowsDb = () =>
    ({
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
      select: () => {
        const chain: any = {
          from: () => chain,
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => Promise.resolve([]),
        };
        return chain;
      },
    }) as any;

  function mkSvc() {
    const db = windowsDb();
    const svc = new RoutingService(db, {} as any, {} as any, {} as any, noAssignments());
    jest.spyOn(svc, 'getRoute').mockResolvedValue(routeFromFarm() as any);
    jest
      .spyOn(svc as any, 'routingSettings')
      .mockResolvedValue({ dayStartHour: 9, slotSizeMin: 60, serviceMin: 10 });
    return svc;
  }

  it('populates a positive distanceFromPrevM and durationFromPrevS on every stop', async () => {
    const p = await mkSvc().generateDeliveryWindows('t1', '2026-07-20');
    const stops = p.couriers[0].stops;
    expect(stops).toHaveLength(2);
    for (const s of stops) {
      expect(typeof s.distanceFromPrevM).toBe('number');
      expect(s.distanceFromPrevM).toBeGreaterThan(0);
      expect(typeof s.durationFromPrevS).toBe('number');
      expect(s.durationFromPrevS).toBeGreaterThanOrEqual(0);
    }
  });

  it('measures the first stop from the courier CURRENT position when supplied, not the farm', async () => {
    const fromFarm = await mkSvc().generateDeliveryWindows('t1', '2026-07-20');
    // A current position essentially on top of stop A (43.20, 27.90).
    const fromHere = await mkSvc().generateDeliveryWindows('t1', '2026-07-20', undefined, undefined, 9, {
      lat: 43.199,
      lng: 27.899,
    });
    expect(fromHere.couriers[0].stops[0].distanceFromPrevM).toBeLessThan(
      fromFarm.couriers[0].stops[0].distanceFromPrevM,
    );
  });

  it('uses REAL per-leg road distance/time when Maps returns legs (not straight-line)', async () => {
    // endMode 'last' → seq = [farm, A, B]; legs = [farm→A, A→B]. The adaptive mock
    // returns leg k with (k+1)·1000 m and (k+1)·300 s.
    const maps = {
      routeFixed: jest.fn((pts: any[]) =>
        Promise.resolve({
          distanceM: 3000,
          durationS: 900,
          polyline: null,
          legs: pts.slice(1).map((_: unknown, k: number) => ({ distanceM: (k + 1) * 1000, durationS: (k + 1) * 300 })),
        }),
      ),
    } as any;
    const db = windowsDb();
    const svc = new RoutingService(db, maps, {} as any, {} as any, noAssignments());
    jest.spyOn(svc, 'getRoute').mockResolvedValue(routeFromFarm() as any);
    jest
      .spyOn(svc as any, 'routingSettings')
      .mockResolvedValue({ dayStartHour: 9, slotSizeMin: 60, serviceMin: 10 });

    const p = await svc.generateDeliveryWindows('t1', '2026-07-20');
    const stops = p.couriers[0].stops;

    expect(stops[0].distanceFromPrevM).toBe(1000);
    expect(stops[0].durationFromPrevS).toBe(300);
    expect(stops[1].distanceFromPrevM).toBe(2000);
    expect(stops[1].durationFromPrevS).toBe(600);
    expect(p.couriers[0].distanceM).toBe(3000); // real whole-leg total
  });

  it('tags each stop with its producer(s) — a multi-farmer order lists all', async () => {
    // farmersByOrder rows: A → Иван; B → Иван + Мария (a shared, cross-farmer order).
    const farmerRows = [
      { orderId: 'A', name: 'Иван' },
      { orderId: 'B', name: 'Иван' },
      { orderId: 'B', name: 'Мария' },
    ];
    const db = {
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
      select: () => {
        const chain: any = {
          from: () => chain,
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => Promise.resolve(farmerRows),
        };
        return chain;
      },
    } as any;
    const svc = new RoutingService(db, {} as any, {} as any, {} as any, noAssignments());
    jest.spyOn(svc, 'getRoute').mockResolvedValue(routeFromFarm() as any);
    jest
      .spyOn(svc as any, 'routingSettings')
      .mockResolvedValue({ dayStartHour: 9, slotSizeMin: 60, serviceMin: 10 });

    const p = await svc.generateDeliveryWindows('t1', '2026-07-20');
    const [a, b] = p.couriers[0].stops;

    expect(a.farmers).toEqual(['Иван']);
    expect(b.farmers).toEqual(['Иван', 'Мария']); // multi-farmer order lists both
  });
});
