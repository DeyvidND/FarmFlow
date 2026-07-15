import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SQL, Param } from 'drizzle-orm';
import { orders } from '@fermeribg/db';
import { RoutingService } from './routing.service';

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
});
