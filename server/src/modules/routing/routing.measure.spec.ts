import { RoutingService } from './routing.service';
import type { Pt } from './route-split';

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
    const svc = new RoutingService(db, maps, {} as any, {} as any, {} as any);

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
    const svc = new RoutingService(db, maps, {} as any, {} as any, {} as any);

    await svc.measureExplicitOrder('t1', '2026-07-07', ['s1'], undefined, 'last');

    const seg = routeFixed.mock.calls[0][0];
    expect(seg[0]).toEqual({ lat: 43.0, lng: 23.0 });
  });
});

// Parallel-chunk regression guard (pathTotal + measureLegs share chunkFixedPath).
// Both used to `await` each ≤25-intermediate chunk's routeFixed call serially;
// they now fire every chunk concurrently via Promise.all. These tests prove the
// seam (last node of chunk N == first node of chunk N+1), the summed totals, and
// the RESULT order still line up with chunk index — not with resolution order —
// plus that a null anywhere in the batch still fails the whole call.
describe('RoutingService pathTotal/measureLegs — parallel chunking', () => {
  // 29 located stops + the depot start = 30 points, one more than the 27-node
  // (25-intermediate) single-chunk cap, so exactly 2 routeFixed chunks fire.
  const STOP_COUNT = 29;
  const stopIds = Array.from({ length: STOP_COUNT }, (_, k) => `s${k}`);
  const stopRows = stopIds.map((id, k) => ({
    id,
    lat: String(43.0 + (k + 1) * 0.001),
    lng: String(23.0 + (k + 1) * 0.001),
  }));

  it('pathTotal (via measureExplicitOrder) parallelizes chunks: seam shared, totals summed, polylines kept in CHUNK order despite out-of-order resolution', async () => {
    // Chunk 0 resolves LATE, chunk 1 resolves immediately — proves the output
    // is ordered by chunk index (array position), not by which promise settles
    // first, which a naive Promise.race-style implementation would get wrong.
    const routeFixed = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ distanceM: 1000, durationS: 100, polyline: 'a' }), 15),
          ),
      )
      .mockImplementationOnce(() => Promise.resolve({ distanceM: 2000, durationS: 200, polyline: 'b' }));
    const maps = { route: jest.fn(), routeFixed, geocode: jest.fn() } as any;
    const db = makeDb([[TENANT], stopRows]);
    const svc = new RoutingService(db, maps, {} as any, {} as any, {} as any);

    // endMode 'last' → no synthetic return-to-depot point, so pts.length ===
    // 1 (depot start) + STOP_COUNT === 30, exactly matching the setup above.
    const result = await svc.measureExplicitOrder('t1', '2026-07-07', stopIds, undefined, 'last');

    expect(routeFixed).toHaveBeenCalledTimes(2);
    const seg0 = routeFixed.mock.calls[0][0] as Pt[];
    const seg1 = routeFixed.mock.calls[1][0] as Pt[];
    expect(seg0).toHaveLength(27); // origin + 25 intermediates + seam
    expect(seg1).toHaveLength(4); // seam + 3 remaining stops
    // Seam: chunk 0's last node IS (same object) chunk 1's first node.
    expect(seg1[0]).toBe(seg0[seg0.length - 1]);

    expect(result.totalDistanceM).toBe(3000);
    expect(result.totalDurationS).toBe(300);
    expect(result.polyline).toEqual(['a', 'b']); // chunk-index order, not resolution order
  });

  it('pathTotal returns null (whole result) when ANY chunk resolves null, after kicking off every chunk concurrently', async () => {
    const routeFixed = jest
      .fn()
      .mockResolvedValueOnce({ distanceM: 1000, durationS: 100, polyline: 'a' })
      .mockResolvedValueOnce(null);
    const maps = { route: jest.fn(), routeFixed, geocode: jest.fn() } as any;
    const db = makeDb([[TENANT], stopRows]);
    const svc = new RoutingService(db, maps, {} as any, {} as any, {} as any);

    const result = await svc.measureExplicitOrder('t1', '2026-07-07', stopIds, undefined, 'last');

    // Both chunks were launched (Promise.all, not a short-circuiting serial
    // loop) even though the 2nd one is the one that fails.
    expect(routeFixed).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ polyline: null, totalDistanceM: null, totalDurationS: null });
  });

  function buildPts(n: number): Pt[] {
    return Array.from({ length: n }, (_, k) => ({ lat: 43.0 + k * 0.001, lng: 23.0 + k * 0.001 }));
  }

  it('measureLegs parallelizes chunks: seam shared, legs/totals concatenated in chunk order despite out-of-order resolution', async () => {
    const pts = buildPts(30); // 30 points → chunk0 = 27 nodes (26 legs), chunk1 = 4 nodes (3 legs)
    const legsA = Array.from({ length: 26 }, (_, k) => ({ distanceM: 100 + k, durationS: 10 + k }));
    const legsB = Array.from({ length: 3 }, (_, k) => ({ distanceM: 900 + k, durationS: 90 + k }));
    const routeFixed = jest
      .fn()
      // Chunk 0 resolves LATE; chunk 1 resolves immediately — output must
      // still be ordered by chunk index.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  distanceM: legsA.reduce((s, l) => s + l.distanceM, 0),
                  durationS: legsA.reduce((s, l) => s + l.durationS, 0),
                  legs: legsA,
                }),
              15,
            ),
          ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          distanceM: legsB.reduce((s, l) => s + l.distanceM, 0),
          durationS: legsB.reduce((s, l) => s + l.durationS, 0),
          legs: legsB,
        }),
      );
    const maps = { route: jest.fn(), routeFixed, geocode: jest.fn() } as any;
    const svc = new RoutingService({} as any, maps, {} as any, {} as any, {} as any);

    const result = await (svc as any).measureLegs(pts);

    expect(routeFixed).toHaveBeenCalledTimes(2);
    const seg0 = routeFixed.mock.calls[0][0] as Pt[];
    const seg1 = routeFixed.mock.calls[1][0] as Pt[];
    expect(seg1[0]).toBe(seg0[seg0.length - 1]); // shared seam node

    expect(result.legs).toEqual([...legsA, ...legsB]); // chunk-index order
    expect(result.distanceM).toBe(
      legsA.reduce((s, l) => s + l.distanceM, 0) + legsB.reduce((s, l) => s + l.distanceM, 0),
    );
    expect(result.durationS).toBe(
      legsA.reduce((s, l) => s + l.durationS, 0) + legsB.reduce((s, l) => s + l.durationS, 0),
    );
  });

  it('measureLegs returns null when ANY chunk resolves null, after kicking off every chunk concurrently', async () => {
    const pts = buildPts(30);
    const legsA = Array.from({ length: 26 }, () => ({ distanceM: 1, durationS: 1 }));
    const routeFixed = jest
      .fn()
      .mockResolvedValueOnce({ distanceM: 26, durationS: 26, legs: legsA })
      .mockResolvedValueOnce(null);
    const maps = { route: jest.fn(), routeFixed, geocode: jest.fn() } as any;
    const svc = new RoutingService({} as any, maps, {} as any, {} as any, {} as any);

    const result = await (svc as any).measureLegs(pts);

    expect(routeFixed).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  it('measureLegs returns null when a chunk\'s legs count does not match its pairs, after kicking off every chunk concurrently', async () => {
    const pts = buildPts(30);
    const legsA = Array.from({ length: 26 }, () => ({ distanceM: 1, durationS: 1 }));
    const routeFixed = jest
      .fn()
      .mockResolvedValueOnce({ distanceM: 26, durationS: 26, legs: legsA })
      // Chunk 1 has 4 nodes → 3 pairs expected; only 2 legs returned → invalid.
      .mockResolvedValueOnce({ distanceM: 2, durationS: 2, legs: [{ distanceM: 1, durationS: 1 }] });
    const maps = { route: jest.fn(), routeFixed, geocode: jest.fn() } as any;
    const svc = new RoutingService({} as any, maps, {} as any, {} as any, {} as any);

    const result = await (svc as any).measureLegs(pts);

    expect(routeFixed).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });
});
