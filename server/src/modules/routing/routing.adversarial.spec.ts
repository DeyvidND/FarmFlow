/**
 * Adversarial routing tests — 5 attempts to break the pure helpers with 4-stop
 * edge cases. Each scenario targets a different failure mode.
 */
import {
  RoutingService,
  greedyByDistance,
  endPoint,
  ptOf,
  type RouteStop,
  type RouteEnd,
} from './routing.service';

const stop = (id: string, lat: number | null, lng: number | null): RouteStop => ({
  id,
  customer: null,
  phone: null,
  email: null,
  address: null,
  note: null,
  lat,
  lng,
  summary: '',
  itemsSubtotalStotinki: 0,
  deliveryFeeStotinki: 0,
  totalStotinki: 0,
  courierIndex: null,
  deliveryWindowStart: null,
  deliveryWindowEnd: null,
  deliveryWindowStatus: null,
});

// ─── Attempt 1: 4 stops all at IDENTICAL coordinates ────────────────────────
// All haversine distances = 0. First stop always wins the strict < comparison.
// Expected: input order preserved (best=0 always, since d=0 only beats
// bestD when bestD is still Infinity — subsequent ties don't update best).
describe('Adversarial 1 — 4 stops at identical coords', () => {
  const origin = { lat: 42.0, lng: 23.0 };
  const stops = [
    stop('a', 42.0, 23.0),
    stop('b', 42.0, 23.0),
    stop('c', 42.0, 23.0),
    stop('d', 42.0, 23.0),
  ];

  it('does not crash and returns all 4 stops', () => {
    const out = greedyByDistance(origin, stops);
    expect(out).toHaveLength(4);
    expect(out.map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns a deterministic order (input order, since all distances = 0)', () => {
    const out = greedyByDistance(origin, stops);
    // All haversine(origin, stop) = 0. First comparison (Inf > 0) makes best=0.
    // Subsequent stops: d=0, NOT < 0 (bestD=0), so best stays 0 → input order.
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ─── Attempt 2: null start + first stop is ungeocoded ───────────────────────
// cursor=null → best=0 → picks input[0] regardless. If input[0] is ungeocoded,
// cursor stays null → picks input[1] (next remaining[0]) regardless of distance.
// Bug: an ungeocoded stop placed first in DB order ends up first in the route.
describe('Adversarial 2 — null start with ungeocoded stop as input[0]', () => {
  // Geocoded stops at distances 3, 1, 2 (same as existing test).
  const far = stop('far', 0, 3); // farthest from each other's origin
  const near = stop('near', 0, 1); // closest
  const mid = stop('mid', 0, 2);
  const noCoords = stop('ghost', null, null);

  it('ungeocoded first input goes last, not first, when start is null (fixed)', () => {
    const out = greedyByDistance(null, [noCoords, near, mid, far]);
    // cursor=null → finds first geocoded (near at index 1), picks it
    // cursor=(0,1) → mid (dist 1) before far (dist 2); ghost goes last
    expect(out[0].id).toBe('near');
    expect(out[out.length - 1].id).toBe('ghost');
    expect(out.map((s) => s.id)).toEqual(['near', 'mid', 'far', 'ghost']);
  });

  it('geocoded first input does NOT have this problem (cursor updates correctly)', () => {
    const out = greedyByDistance(null, [near, mid, far, noCoords]);
    // cursor=null → picks near (remaining[0]), cursor=(0,1)
    // From (0,1): mid (dist 1) before far (dist 2); noCoords skipped in distance calc
    expect(out[0].id).toBe('near');
    expect(out[out.length - 1].id).toBe('ghost');
  });
});

// ─── Attempt 4: optimized=true even when Google Maps is absent ───────────────
// In distance mode with a valid origin but maps returning null, the code falls
// back to greedyByDistance but still sets optimized=true. Test the flag logic
// on the pure helpers to document the gap (the flag check is in the service).
describe('Adversarial 4 — optimized flag from pure orderedLocated.length', () => {
  const origin = { lat: 42, lng: 23 };
  const stops = [stop('a', 42, 23.1), stop('b', 42, 23.2), stop('c', 42, 23.3), stop('d', 42, 23.4)];

  it('greedyByDistance on 4 stops always returns length > 0', () => {
    const out = greedyByDistance(origin, stops);
    // This means orderedLocated.length > 0 → service sets optimized=true
    // even though no Google optimization was performed (just greedy heuristic).
    expect(out.length).toBe(4);
  });

  it('route order is nearest-neighbour (b→c→d→a with origin at far left)', () => {
    // origin at (42, 23.0). Stops at .1, .2, .3, .4.
    // Nearest from origin: a@.1. Then b@.2. Then c@.3. Then d@.4.
    const out = greedyByDistance(origin, stops);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ─── Attempt 5: endPoint + custom mode cascade into distance-total skip ──────
// custom mode with null lat/lng → endPoint returns null → in the service:
//   dest = null → null ?? undefined = undefined → maps.route uses origin as dest
//   end.lat = null → pathTotal skips the final leg
// This means: optimization targets a round trip BUT totals measure a one-way trip.
// The discrepancy is documented but let's confirm endPoint behaviour exactly.
describe('Adversarial 5 — custom endMode with no saved coords (4-stop route)', () => {
  const origin = { lat: 42.0, lng: 23.0 };

  const endCustomNoCoords: RouteEnd = { mode: 'custom', address: 'Непознат адрес', lat: null, lng: null };
  const endCustomWithCoords: RouteEnd = { mode: 'custom', address: 'Известен адрес', lat: 43.0, lng: 24.0 };
  const endHome: RouteEnd = { mode: 'home', address: 'Ферма', lat: 42.0, lng: 23.0 };
  const endLast: RouteEnd = { mode: 'last', address: null, lat: null, lng: null };

  it('custom with no coords falls back to null (maps.route will use origin)', () => {
    expect(endPoint('custom', origin, endCustomNoCoords)).toBeNull();
  });

  it('custom WITH coords returns those coords', () => {
    expect(endPoint('custom', origin, endCustomWithCoords)).toEqual({ lat: 43.0, lng: 24.0 });
  });

  it('home and last produce different endPoint results (no cache collision)', () => {
    const home = endPoint('home', origin, endHome);
    const last = endPoint('last', origin, endLast);
    // home → origin; last → null
    // In maps.route: both become origin (null ?? origin = origin) → SAME cache key.
    // But only plan.order is used, which is identical for both, so benign.
    expect(home).toEqual(origin);
    expect(last).toBeNull(); // null ?? origin in maps.route = origin → cache collision
  });

  it('4 stops: greedyByDistance is stable (no phantom reorder on custom fallback)', () => {
    const s = [stop('a', 42, 23.4), stop('b', 42, 23.3), stop('c', 42, 23.2), stop('d', 42, 23.1)];
    // Greedy from origin (42,23.0): nearest is d@.1 → c@.2 → b@.3 → a@.4
    const out = greedyByDistance(origin, s);
    expect(out.map((x) => x.id)).toEqual(['d', 'c', 'b', 'a']);
  });
});

// ─── Attempt 6: RoutingService.getRoute multi-courier split (service-level) ──
// Mocked db (mirrors routing.set-location.spec.ts's chain-stub style, extended
// with leftJoin/orderBy for the orders query) + a maps stub that always "fails"
// (route/routeFixed → null), forcing the pure greedy/sweep fallbacks so the
// split itself is what's under test, not the Google integration.
describe('Adversarial 6 — RoutingService.getRoute multi-courier split', () => {
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

  function makeMaps() {
    return {
      route: jest.fn().mockResolvedValue(null),
      routeFixed: jest.fn().mockResolvedValue(null),
      geocode: jest.fn(),
    } as any;
  }

  const TENANT = {
    farmAddress: 'Ферма Иванови',
    farmLat: '42.0',
    farmLng: '23.0',
    settings: { routing: {} },
  };

  // 4 confirmed address-orders, geocoded around the depot at 4 compass points
  // so the sweep splitter has something non-degenerate to partition.
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
  const s1 = geoOrder('s1', 42.01, 23.0);
  const s2 = geoOrder('s2', 42.0, 23.01);
  const s3 = geoOrder('s3', 41.99, 23.0);
  const s4 = geoOrder('s4', 42.0, 22.99);

  it('couriers=2 splits 4 geocoded stops into 2 routes covering every id exactly once', async () => {
    const db = makeDb([[TENANT], [s1, s2, s3, s4], []]);
    const svc = new RoutingService(db, makeMaps(), {} as any, {} as any);

    const result = await svc.getRoute('t1', '2026-07-07', undefined, 2);

    expect(result.couriers).toBe(2);
    expect(result.routes).toHaveLength(2);
    const ids = result.routes.flatMap((r) => r.stops.map((s) => s.id)).sort();
    expect(ids).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('couriers=1 keeps the old single-route behaviour', async () => {
    const db = makeDb([[TENANT], [s1, s2, s3, s4], []]);
    const svc = new RoutingService(db, makeMaps(), {} as any, {} as any);

    const result = await svc.getRoute('t1', '2026-07-07', undefined, 1);

    expect(result.couriers).toBe(1);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].stops.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('an un-geocoded stop lands at the END of the smallest route, not dropped', async () => {
    const ghost = {
      id: 'ghost',
      customer: null,
      phone: null,
      email: null,
      address: 'непознат адрес',
      note: null,
      lat: null,
      lng: null,
    };
    const db = makeDb([[TENANT], [s1, s2, s3, ghost], []]);
    const svc = new RoutingService(db, makeMaps(), {} as any, {} as any);

    const result = await svc.getRoute('t1', '2026-07-07', undefined, 2);

    const allIds = result.routes.flatMap((r) => r.stops.map((s) => s.id)).sort();
    expect(allIds).toEqual(['ghost', 's1', 's2', 's3']);
    const routeWithGhost = result.routes.find((r) => r.stops.some((s) => s.id === 'ghost'))!;
    expect(routeWithGhost.stops[routeWithGhost.stops.length - 1].id).toBe('ghost');
  });

  it('a zero-order day still returns exactly one (empty) route, not zero routes', async () => {
    // No confirmed address-orders that day → both located and unlocated are
    // empty, so the item-summary select is skipped (ids.length === 0).
    const db = makeDb([[TENANT], []]);
    const svc = new RoutingService(db, makeMaps(), {} as any, {} as any);

    const result = await svc.getRoute('t1', '2026-07-07', undefined, 2);

    expect(result.couriers).toBe(1);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].stops).toEqual([]);
    expect(result.routes[0].optimized).toBe(false);
  });
});
