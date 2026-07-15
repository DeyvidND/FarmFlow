import { RoutingService } from './routing.service';

// Service-level proof that a Google visit order which delivers a driven-past
// stop out of sequence gets re-sorted for the human eye — and that the road-time
// guard reverts the tidy order when it would cost a real detour.
describe('RoutingService.getRoute — human-readable order smoothing', () => {
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

  // Depot well WEST of the stops so "left to right along the line" is the
  // crow-flies-natural order.
  const TENANT = {
    farmAddress: 'Ферма',
    farmLat: '42.0',
    farmLng: '22.9',
    settings: { routing: {} },
  };
  // Guard test depot: AT the square's fourth corner (local origin).
  const TENANT2 = {
    farmAddress: 'Ферма',
    farmLat: '42.0',
    farmLng: '23.0',
    settings: { routing: {} },
  };
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

  // Task A3 — no per-day assignment board rows here; leg-count precedence is a no-op.
  const noAssignments = () => ({ getAssignmentsForDay: jest.fn().mockResolvedValue([]) }) as any;

  it('pulls a driven-past stop back into sequence (one-way route)', async () => {
    // Three stops on an east-running line; M sits between A and B.
    const A = geoOrder('A', 42.0, 23.0);
    const B = geoOrder('B', 42.0, 23.02);
    const M = geoOrder('M', 42.0, 23.01);
    const db = makeDb([[TENANT], [A, B, M], []]);

    // Google-style optimizer: orders by longitude but drops the MIDDLE stop to
    // the end (the "+30s" artifact) → googleHead = [A, B, M].
    const maps = {
      route: jest.fn(async (_o: any, pts: any[]) => {
        const idx = pts.map((_, i) => i).sort((a, b) => pts[a].lng - pts[b].lng);
        const mid = idx.splice(Math.floor(idx.length / 2), 1)[0];
        idx.push(mid);
        return { order: idx, distanceM: 1000, durationS: 600, polyline: 'g' };
      }),
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 900, durationS: 610, polyline: 'r' }),
      geocode: jest.fn(),
    } as any;
    const svc = new RoutingService(db, maps, {} as any, {} as any, noAssignments());

    // One-way (`last`): the last stop is free, so in-sequence is a clear win.
    const result = await svc.getRoute('t1', '2026-07-07', 'last', 1);

    expect(result.routes[0].stops.map((s) => s.id)).toEqual(['A', 'M', 'B']);
  });

  it('reverts to Google order when the tidy order would cost a big detour', async () => {
    // Square: depot at origin, A/B/C at three corners. A crossing visit order is
    // shorter in crow-flies once un-crossed, but here routeFixed reports the
    // tidy order as hugely slower (a river the straight-line metric can't see),
    // so the guard must keep Google's (crossing) order.
    const A = geoOrder('A', 42.0, 23.01); // (1,0)-ish corner
    const B = geoOrder('B', 42.01, 23.01); // (1,1)
    const C = geoOrder('C', 42.01, 23.0); // (0,1)
    const db = makeDb([[TENANT2], [A, B, C], []]);

    const want = [
      { lat: 42.01, lng: 23.01 }, // B
      { lat: 42.0, lng: 23.01 }, // A
      { lat: 42.01, lng: 23.0 }, // C
    ];
    const maps = {
      route: jest.fn(async (_o: any, pts: any[]) => {
        const order = want.map((w) => pts.findIndex((p) => p.lat === w.lat && p.lng === w.lng));
        return { order, distanceM: 1000, durationS: 600, polyline: 'g' };
      }),
      // Tidy (un-crossed) order re-measures as absurdly slow → over the guard.
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 5000, durationS: 99999, polyline: 'r' }),
      geocode: jest.fn(),
    } as any;
    const svc = new RoutingService(db, maps, {} as any, {} as any, noAssignments());

    // Home (round trip): reordered + dest!=null → the guard branch runs.
    const result = await svc.getRoute('t1', '2026-07-07', 'home', 1);

    // Guard reverted: Google's crossing order is kept, with Google's own totals.
    expect(result.routes[0].stops.map((s) => s.id)).toEqual(['B', 'A', 'C']);
    expect(result.routes[0].totalDurationS).toBe(600);
  });
});
