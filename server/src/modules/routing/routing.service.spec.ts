import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SQL, Param } from 'drizzle-orm';
import { orders } from '@fermeribg/db';
import { RoutingService } from './routing.service';
import { estimateWorkloadS, type Pt } from './route-split';

// positionCase itself is exercised elsewhere (reorder.util is shared with
// products/farmers/subcategories); here we only need to assert setOrderSequence
// calls it with the right (id, position) pairs, so stub it out.
jest.mock('../../common/db/reorder.util', () => ({
  positionCase: jest.fn(() => 'ROUTE_SEQ_CASE_SQL'),
}));
import { positionCase } from '../../common/db/reorder.util';

/**
 * Walk a drizzle `and(eq(...), eq(...))` SQL tree and pull out every embedded
 * chunk (Column references and Param values), so a test can assert the WHERE
 * clause actually scoped on specific columns/values instead of just trusting
 * the mock resolved — a missing tenantId eq() would silently open a
 * cross-tenant write.
 */
function flattenSql(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof SQL) {
    for (const chunk of (node as unknown as { queryChunks: unknown[] }).queryChunks) {
      flattenSql(chunk, out);
    }
  } else if (Array.isArray(node)) {
    // inArray() embeds its per-value Params as a raw array chunk (not
    // wrapped in another SQL), e.g. `orders.id in [Param, Param]`.
    for (const item of node) flattenSql(item, out);
  } else {
    out.push(node);
  }
  return out;
}

function paramValues(node: unknown): unknown[] {
  return flattenSql(node).filter((c): c is Param => c instanceof Param).map((p) => p.value);
}

function hasColumn(node: unknown, col: unknown): boolean {
  return flattenSql(node).includes(col);
}

describe('RoutingService.setOrderCourier', () => {
  function buildDb(returningResult: unknown[]) {
    const whereCalls: unknown[] = [];
    const setCalls: unknown[] = [];
    const chain: any = {};
    chain.update = jest.fn(() => chain);
    chain.set = jest.fn((v: unknown) => {
      setCalls.push(v);
      return chain;
    });
    chain.where = jest.fn((w: unknown) => {
      whereCalls.push(w);
      return { returning: jest.fn(() => Promise.resolve(returningResult)) };
    });
    return { db: chain, whereCalls, setCalls };
  }

  function makeSvc(db: unknown) {
    return new RoutingService(db as never, {} as never, {} as never, {} as never, {} as never);
  }

  it('rejects a negative courierIndex', async () => {
    const { db } = buildDb([{ id: 'order-1' }]);
    const svc = makeSvc(db);
    await expect(svc.setOrderCourier('tenant-1', 'order-1', -1)).rejects.toThrow(
      new BadRequestException('Невалиден куриер'),
    );
  });

  it('rejects a non-integer courierIndex', async () => {
    const { db } = buildDb([{ id: 'order-1' }]);
    const svc = makeSvc(db);
    await expect(svc.setOrderCourier('tenant-1', 'order-1', 1.5)).rejects.toThrow(
      new BadRequestException('Невалиден куриер'),
    );
  });

  it('rejects courierIndex 10 (just past the allowed max of 9)', async () => {
    const { db } = buildDb([{ id: 'order-1' }]);
    const svc = makeSvc(db);
    await expect(svc.setOrderCourier('tenant-1', 'order-1', 10)).rejects.toThrow(
      new BadRequestException('Невалиден куриер'),
    );
  });

  it('accepts courierIndex 0 and returns { id, courierIndex }', async () => {
    const { db, setCalls } = buildDb([{ id: 'order-1' }]);
    const svc = makeSvc(db);
    const result = await svc.setOrderCourier('tenant-1', 'order-1', 0);
    expect(result).toEqual({ id: 'order-1', courierIndex: 0 });
    expect(setCalls).toEqual([{ courierIndex: 0 }]);
  });

  it('accepts null (clears the pin) and returns { id, courierIndex: null }', async () => {
    const { db, setCalls } = buildDb([{ id: 'order-1' }]);
    const svc = makeSvc(db);
    const result = await svc.setOrderCourier('tenant-1', 'order-1', null);
    expect(result).toEqual({ id: 'order-1', courierIndex: null });
    expect(setCalls).toEqual([{ courierIndex: null }]);
  });

  it('throws NotFoundException when the tenant-scoped WHERE matches no rows (foreign order)', async () => {
    const { db } = buildDb([]); // .returning() resolves empty — nothing updated.
    const svc = makeSvc(db);
    await expect(svc.setOrderCourier('tenant-1', 'foreign-order', 0)).rejects.toThrow(
      new NotFoundException('Поръчката не е намерена'),
    );
  });

  it('scopes the UPDATE WHERE by both the order id AND the tenant id (no cross-tenant write)', async () => {
    const { db, whereCalls } = buildDb([{ id: 'order-1' }]);
    const svc = makeSvc(db);
    await svc.setOrderCourier('tenant-1', 'order-1', 0);

    expect(whereCalls).toHaveLength(1);
    const where = whereCalls[0];
    expect(hasColumn(where, orders.id)).toBe(true);
    expect(hasColumn(where, orders.tenantId)).toBe(true);
    expect(paramValues(where)).toEqual(expect.arrayContaining(['order-1', 'tenant-1']));
  });
});

describe('RoutingService.setOrderSequence', () => {
  beforeEach(() => jest.clearAllMocks());

  function buildDb() {
    const whereCalls: unknown[] = [];
    const setCalls: unknown[] = [];
    const chain: any = {};
    chain.update = jest.fn(() => chain);
    chain.set = jest.fn((v: unknown) => {
      setCalls.push(v);
      return chain;
    });
    chain.where = jest.fn((w: unknown) => {
      whereCalls.push(w);
      return Promise.resolve(undefined);
    });
    return { db: chain, whereCalls, setCalls };
  }

  function makeSvc(db: unknown) {
    return new RoutingService(db as never, {} as never, {} as never, {} as never, {} as never);
  }

  it('empty stopIds clears routeSeq for every order pinned to that courierIndex (scoped by tenant, not stop ids)', async () => {
    const { db, whereCalls, setCalls } = buildDb();
    const svc = makeSvc(db);
    const result = await svc.setOrderSequence('tenant-1', 1, []);

    expect(result).toEqual({ courierIndex: 1, count: 0 });
    expect(setCalls).toEqual([{ routeSeq: null }]);
    expect(positionCase).not.toHaveBeenCalled();

    expect(whereCalls).toHaveLength(1);
    const where = whereCalls[0];
    expect(hasColumn(where, orders.tenantId)).toBe(true);
    expect(hasColumn(where, orders.courierIndex)).toBe(true);
    // Nothing about stop ids should appear on the clear path.
    expect(hasColumn(where, orders.id)).toBe(false);
    expect(paramValues(where)).toEqual(expect.arrayContaining(['tenant-1', 1]));
  });

  it('non-empty stopIds sets courierIndex on every listed order and builds routeSeq via positionCase in file order', async () => {
    const { db, setCalls } = buildDb();
    const svc = makeSvc(db);
    const result = await svc.setOrderSequence('tenant-1', 2, ['stop-b', 'stop-a', 'stop-c']);

    expect(result).toEqual({ courierIndex: 2, count: 3 });
    expect(positionCase).toHaveBeenCalledWith(orders.id, orders.routeSeq, [
      { id: 'stop-b', position: 0 },
      { id: 'stop-a', position: 1 },
      { id: 'stop-c', position: 2 },
    ]);
    expect(setCalls).toEqual([{ courierIndex: 2, routeSeq: 'ROUTE_SEQ_CASE_SQL' }]);
  });

  it('sequencing one courier leg scopes the WHERE to inArray(orders.id, stopIds) + tenant, never touching a stop id outside the list', async () => {
    const { db, whereCalls } = buildDb();
    const svc = makeSvc(db);
    await svc.setOrderSequence('tenant-1', 2, ['stop-a', 'stop-b']);

    expect(whereCalls).toHaveLength(1);
    const where = whereCalls[0];
    expect(hasColumn(where, orders.id)).toBe(true);
    expect(hasColumn(where, orders.tenantId)).toBe(true);
    // The listed stop ids and the tenant id are the only values scoped in —
    // an id from another courier's leg that wasn't passed in never appears.
    expect(paramValues(where)).toEqual(expect.arrayContaining(['stop-a', 'stop-b', 'tenant-1']));
    expect(paramValues(where)).not.toContain('other-couriers-stop');
  });
});

// Task A3 — the per-day assignment board (Task A2's getAssignmentsForDay) takes
// precedence over BOTH the ?couriers= dropdown and the tenant's saved
// settings.routing.courierCount default: any assignment rows for the date mean
// the split uses the count of DISTINCT assigned legIndex values instead. Zero
// assignment rows for the date leave today's dropdown/settings behavior intact.
describe('RoutingService.getRoute — assignment board overrides leg count', () => {
  function makeDb(selectResults: any[][]) {
    const results = [...selectResults];
    const db = {
      select: () => {
        const result = results.length ? results.shift()! : [];
        const chain: any = {
          from: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          orderBy: () => Promise.resolve(result),
          limit: () => Promise.resolve(result),
          then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
        };
        return chain;
      },
    } as any;
    return db;
  }

  const geoOrder = (id: string, lat: number, lng: number) => ({
    id,
    customer: null,
    phone: null,
    email: null,
    address: `адрес ${id}`,
    note: null,
    lat: String(lat),
    lng: String(lng),
  });

  // Six geocoded stops around the depot, same fixture shape as
  // routing.courier-default.spec.ts, so a sweep split has room to carve out
  // however many legs the test requests.
  const stops = () => [
    geoOrder('A', 43.24, 27.9),
    geoOrder('B', 43.23, 27.95),
    geoOrder('C', 43.2, 27.98),
    geoOrder('D', 43.16, 27.96),
    geoOrder('E', 43.14, 27.9),
    geoOrder('F', 43.18, 27.86),
  ];

  const makeMaps = () =>
    ({
      route: jest.fn(async (_o: any, pts: any[]) => ({
        order: pts.map((_: any, i: number) => i),
        distanceM: 1000,
        durationS: 600,
        polyline: 'g',
      })),
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 900, durationS: 600, polyline: 'r' }),
      geocode: jest.fn(),
    }) as any;

  const tenant = (routing: Record<string, unknown> = {}) => ({
    farmAddress: 'Ферма',
    farmLat: '43.17',
    farmLng: '27.84',
    settings: { routing },
  });

  it('(a) assignment rows for the date override BOTH ?couriers= and the saved default', async () => {
    const db = makeDb([[tenant({ courierCount: 3 })], stops(), []]);
    const assignments = {
      getAssignmentsForDay: jest
        .fn()
        .mockResolvedValue([
          { accountId: 'driver-1', legIndex: 0 },
          { accountId: 'driver-2', legIndex: 1 },
        ]),
    } as any;
    const svc = new RoutingService(db, makeMaps(), {} as any, {} as any, assignments);

    // ?couriers=1 AND a saved courierCount of 3 — the 2 DISTINCT assigned legs
    // (0 and 1) must win over both.
    const result = await svc.getRoute('t1', '2026-07-15', undefined, 1);

    expect(assignments.getAssignmentsForDay).toHaveBeenCalledWith('t1', '2026-07-15');
    expect(result.couriers).toBe(2);
    expect(result.routes).toHaveLength(2);
  });

  it('(b) zero assignment rows for the date leave the ?couriers= dropdown behavior unchanged', async () => {
    const db = makeDb([[tenant({ courierCount: 3 })], stops(), []]);
    const assignments = {
      getAssignmentsForDay: jest.fn().mockResolvedValue([]),
    } as any;
    const svc = new RoutingService(db, makeMaps(), {} as any, {} as any, assignments);

    const result = await svc.getRoute('t1', '2026-07-15', undefined, 1);

    expect(result.couriers).toBe(1);
    expect(result.routes).toHaveLength(1);
  });

  // Bug found investigating a real-world imbalance report: each roster row on
  // the assignment board picks its leg independently, so a NON-contiguous set
  // of assigned legs (e.g. [0, 2], leg 1 left unassigned) is a normal, expected
  // shape — not an edge case. sweepSplit/optimizeGroup work over a dense
  // 0..n-1 array position internally; without a position->leg mapping, a
  // route's `courierIndex` output was the array position, not the real leg —
  // so a driver assigned leg 2 would never match any route (array positions
  // only ever go up to n-1=1) and would silently see zero stops.
  it('(c) non-contiguous assigned legs (e.g. [0, 2]) come back with their REAL legIndex, not a dense 0..n-1 position', async () => {
    const db = makeDb([[tenant()], stops(), []]);
    const assignments = {
      getAssignmentsForDay: jest.fn().mockResolvedValue([
        { accountId: 'driver-1', legIndex: 0 },
        { accountId: 'driver-3', legIndex: 2 }, // leg 1 deliberately unassigned
      ]),
    } as any;
    const svc = new RoutingService(db, makeMaps(), {} as any, {} as any, assignments);

    const result = await svc.getRoute('t1', '2026-07-15');

    expect(result.couriers).toBe(2);
    expect(result.routes.map((r) => r.courierIndex).sort((a, b) => a - b)).toEqual([0, 2]);
    // Never a stray dense-position leg (1) that no assigned account owns.
    expect(result.routes.some((r) => r.courierIndex === 1)).toBe(false);
  });

  // Same non-contiguous-leg fix, from the order-pin side: a pin's
  // courierIndex is a REAL leg number, and must land in the array slot that
  // actually corresponds to that leg — not be used as a raw (and, for a
  // non-contiguous leg set, out-of-bounds-relative-to-n) array index.
  // settings.routing.couriers[] is indexed by the REAL courier/leg number (the
  // homes modal edits „Куриер N" at couriers[N-1]; measureExplicitOrder looks up
  // couriersCfg[courierIndex] with the real leg). getRoute must therefore
  // resolve each route's saved config (name, endMode, home) by posToLeg[i],
  // not by the dense array position i — otherwise a non-contiguous board day
  // (legs [0, 2]) gives the leg-2 route courier 2's (Куриер 2, config index 1)
  // name AND ends the actually-driven route at that wrong courier's home.
  it("(e) a non-contiguous leg's saved config (name + home end) comes from couriers[legIndex], not couriers[position]", async () => {
    const couriersCfg = [
      { name: 'Куриер А' },
      { name: 'Куриер Б', homeAddress: 'дом Б', homeLat: '43.30', homeLng: '27.70' },
      { name: 'Куриер В', homeAddress: 'дом В', homeLat: '43.10', homeLng: '28.00' },
    ];
    const db = makeDb([[tenant({ couriers: couriersCfg })], stops(), []]);
    const assignments = {
      getAssignmentsForDay: jest.fn().mockResolvedValue([
        { accountId: 'driver-1', legIndex: 0 },
        { accountId: 'driver-3', legIndex: 2 }, // leg 1 deliberately unassigned
      ]),
    } as any;
    const svc = new RoutingService(db, makeMaps(), {} as any, {} as any, assignments);

    const result = await svc.getRoute('t1', '2026-07-15');

    const leg2 = result.routes.find((r) => r.courierIndex === 2)!;
    expect(leg2.name).toBe('Куриер В');
    expect(leg2.endAddress).toBe('дом В');
    expect(leg2.endLat).toBe(43.1);
    expect(leg2.endLng).toBe(28.0);
    const leg0 = result.routes.find((r) => r.courierIndex === 0)!;
    expect(leg0.name).toBe('Куриер А');
  });

  it('(d) an order pinned to a non-contiguous assigned leg lands on that leg\'s route, not a mismatched slot', async () => {
    const pinnedStops = stops().map((s, i) => (i === 0 ? { ...s, courierIndex: 2 } : s));
    const db = makeDb([[tenant()], pinnedStops, []]);
    const assignments = {
      getAssignmentsForDay: jest.fn().mockResolvedValue([
        { accountId: 'driver-1', legIndex: 0 },
        { accountId: 'driver-3', legIndex: 2 },
      ]),
    } as any;
    const svc = new RoutingService(db, makeMaps(), {} as any, {} as any, assignments);

    const result = await svc.getRoute('t1', '2026-07-15');

    const leg2 = result.routes.find((r) => r.courierIndex === 2)!;
    expect(leg2.stops.some((s) => s.id === 'A')).toBe(true);
  });

  // Audit follow-up Task 1: pin-aware balancing. Before the fix, getRoute fed
  // sweepSplit ONLY the free stops and dumped pins on afterward with zero
  // visibility into how loaded a pinned courier already was — the exact
  // mechanism behind a real 20-delivery, 4.56:1 imbalance. Pin 2 of the 6
  // stops (A, B) to courier 0, leaving 4 free (C, D, E, F, more than the 2
  // couriers so sweepSplit's real balancing engages, not its "≤ n stops"
  // one-each shortcut) — courier 0 should come back with FEWER of those free
  // stops than courier 1, and the two couriers' estimated total workloads
  // (pinned base + assigned free stops) should land in the same ballpark
  // rather than courier 0 being pinned-base-heavy AND getting an even share
  // of the free stops on top.
  it('getRoute gives a courier with pinned stops fewer of the remaining free stops, keeping total workload balanced', async () => {
    const pinnedStops = stops().map((s, i) => (i < 2 ? { ...s, courierIndex: 0 } : s)); // A, B -> courier 0
    const db = makeDb([[tenant()], pinnedStops, []]);
    const assignments = { getAssignmentsForDay: jest.fn().mockResolvedValue([]) } as any;
    const svc = new RoutingService(db, makeMaps(), {} as any, {} as any, assignments);

    const result = await svc.getRoute('t1', '2026-07-15', undefined, 2);

    expect(result.routes).toHaveLength(2);
    const leg0 = result.routes.find((r) => r.courierIndex === 0)!;
    const leg1 = result.routes.find((r) => r.courierIndex === 1)!;
    const freeIds = ['C', 'D', 'E', 'F'];
    const leg0FreeCount = leg0.stops.filter((s) => freeIds.includes(s.id)).length;
    const leg1FreeCount = leg1.stops.filter((s) => freeIds.includes(s.id)).length;

    // All 4 free stops accounted for, none duplicated/lost.
    expect(leg0FreeCount + leg1FreeCount).toBe(4);
    // The already-pinned courier gets strictly fewer of the free stops than
    // an even 2/2 split would have given it.
    expect(leg0FreeCount).toBeLessThan(2);
    expect(leg1FreeCount).toBeGreaterThan(2);

    // Concrete balance property: estimate each courier's TOTAL workload
    // (pinned base, estimated the same way getRoute itself does, + its
    // assigned free stops) and assert neither courier is wildly more loaded
    // than the other — the failure mode this guards against is courier 0
    // ending up near base-alone while courier 1 silently absorbs everything.
    const depot: Pt = { lat: 43.17, lng: 27.84 };
    const pinnedPts: Pt[] = [
      { lat: 43.24, lng: 27.9 }, // A
      { lat: 43.23, lng: 27.95 }, // B
    ];
    const base0 = estimateWorkloadS(depot, pinnedPts, depot);
    const leg0FreePts = leg0.stops
      .filter((s) => freeIds.includes(s.id))
      .map((s) => ({ lat: s.lat as number, lng: s.lng as number }));
    const leg1FreePts = leg1.stops
      .filter((s) => freeIds.includes(s.id))
      .map((s) => ({ lat: s.lat as number, lng: s.lng as number }));
    const total0 = base0 + estimateWorkloadS(depot, leg0FreePts, depot);
    const total1 = estimateWorkloadS(depot, leg1FreePts, depot);
    const avg = (total0 + total1) / 2;
    expect(Math.max(total0, total1)).toBeLessThanOrEqual(avg * 1.6 + 1e-6);
  });

  // Audit follow-up Task 3: consistency regression guard. e1b3d9fe (server)
  // and 0479dcef (client) both fixed the same class of bug — a per-courier
  // saved config (name/home/endMode) resolved by dense array POSITION instead
  // of the REAL (possibly non-contiguous) legIndex, so a driver on leg 2 of a
  // [0, 2] board got courier-array-index-1's config instead of couriers[2]'s.
  // This guard would fail immediately if getRoute and measureExplicitOrder
  // ever resolved a DIFFERENT end for the same leg/date again — e.g. if a
  // future change made either method index couriersCfg by array position.
  it('getRoute and measureExplicitOrder resolve the SAME end config for the same (non-contiguous) leg', async () => {
    // Leg 2's config only sets endMode (no home address) — deliberately
    // avoids the courier-home case, which exercises an unrelated pre-existing
    // quirk in `endPoint()` (its `mode` param doesn't reflect endForCourier's
    // mode->'custom' upgrade for a per-courier home); keeping this guard
    // scoped to the ALREADY-FIXED position-vs-legIndex indexing bug only.
    const couriersCfg = [{}, {}, { endMode: 'last' }];
    const assignments = {
      getAssignmentsForDay: jest.fn().mockResolvedValue([
        { accountId: 'driver-1', legIndex: 0 },
        { accountId: 'driver-3', legIndex: 2 }, // leg 1 deliberately unassigned
      ]),
    } as any;
    // Google disabled (route -> null) so getRoute's totals come from the
    // `end.lat/end.lng`-driven fallback path, matching what
    // measureExplicitOrder always uses (it never reorders/calls Google).
    const maps = {
      route: jest.fn().mockResolvedValue(null),
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 900, durationS: 600, polyline: 'r' }),
      geocode: jest.fn(),
    } as any;

    const routeDb = makeDb([[tenant({ couriers: couriersCfg })], stops(), []]);
    const routeSvc = new RoutingService(routeDb, maps, {} as any, {} as any, assignments);
    const route = await routeSvc.getRoute('t1', '2026-07-15');
    const leg0 = route.routes.find((r) => r.courierIndex === 0)!;
    const leg2 = route.routes.find((r) => r.courierIndex === 2)!;
    expect(leg0.endMode).toBe('home');
    expect(leg2.endMode).toBe('last');
    expect(leg2.endLat).toBeNull();
    expect(leg2.endLng).toBeNull();

    // measureExplicitOrder for leg 0 (day-wide default 'home'): round trip —
    // the last point fed to the Maps call must be the SAME depot leg0 ended at.
    maps.routeFixed.mockClear();
    const db0 = makeDb([[tenant({ couriers: couriersCfg })], [{ id: 'A', lat: '43.24', lng: '27.9' }]]);
    const svc0 = new RoutingService(db0, maps, {} as any, {} as any, assignments);
    await svc0.measureExplicitOrder('t1', '2026-07-15', ['A'], 0);
    const ptsLeg0 = maps.routeFixed.mock.calls.at(-1)![0] as Pt[];
    expect(ptsLeg0).toHaveLength(3); // origin, stop, return-to-depot end point
    expect(ptsLeg0.at(-1)).toEqual({ lat: leg0.endLat, lng: leg0.endLng });

    // measureExplicitOrder for leg 2 — passed the REAL leg number (2), not
    // its array POSITION (1) in this non-contiguous [0, 2] board — must
    // resolve couriers[2]'s endMode: 'last' too, same as getRoute did.
    maps.routeFixed.mockClear();
    const db2 = makeDb([[tenant({ couriers: couriersCfg })], [{ id: 'A', lat: '43.24', lng: '27.9' }]]);
    const svc2 = new RoutingService(db2, maps, {} as any, {} as any, assignments);
    await svc2.measureExplicitOrder('t1', '2026-07-15', ['A'], 2);
    const ptsLeg2 = maps.routeFixed.mock.calls.at(-1)![0] as Pt[];
    expect(ptsLeg2).toHaveLength(2); // origin, stop — no return leg (one-way)
  });
});
