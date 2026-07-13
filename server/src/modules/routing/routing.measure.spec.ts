import { RoutingService } from './routing.service';

// Mirrors routing.set-location.spec.ts's chain-stub style: successive
// select() calls consume the next pre-loaded result; the chain itself is
// "thenable" so the coord lookup (which never calls .limit()) still awaits.
function makeDb(selectResults: any[][]) {
  const results = [...selectResults];
  const db = {
    select: () => {
      const result = results.length ? results.shift()! : [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(result),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
  } as any;
  return db;
}

const TENANT = { farmAddress: 'Ферма', farmLat: '43.0', farmLng: '23.0', settings: { routing: {} } };
const STOP = { id: 's1', lat: '43.05', lng: '23.05' };

describe('RoutingService.measureExplicitOrder — en-route start point (task #7 fix)', () => {
  it('anchors the measured path at the given start, not the depot, when start is provided', async () => {
    const routeFixed = jest.fn().mockResolvedValue({ distanceM: 1000, durationS: 300, polyline: 'p' });
    const maps = { route: jest.fn(), routeFixed, geocode: jest.fn() } as any;
    const db = makeDb([[TENANT], [STOP]]);
    const svc = new RoutingService(db, maps, {} as any, {} as any);

    const start = { lat: 43.02, lng: 23.02 };
    // endMode 'last' (one-way) keeps the point sequence to exactly
    // [start, stop] — no return-leg point to also account for.
    await svc.measureExplicitOrder('t1', '2026-07-07', ['s1'], undefined, 'last', start);

    expect(routeFixed).toHaveBeenCalledTimes(1);
    const seg = routeFixed.mock.calls[0][0];
    expect(seg[0]).toEqual(start);
    expect(seg[0]).not.toEqual({ lat: 43.0, lng: 23.0 }); // NOT the depot
  });

  it('falls back to the depot as the start point when none is given (unchanged default)', async () => {
    const routeFixed = jest.fn().mockResolvedValue({ distanceM: 1000, durationS: 300, polyline: 'p' });
    const maps = { route: jest.fn(), routeFixed, geocode: jest.fn() } as any;
    const db = makeDb([[TENANT], [STOP]]);
    const svc = new RoutingService(db, maps, {} as any, {} as any);

    await svc.measureExplicitOrder('t1', '2026-07-07', ['s1'], undefined, 'last');

    const seg = routeFixed.mock.calls[0][0];
    expect(seg[0]).toEqual({ lat: 43.0, lng: 23.0 });
  });
});
