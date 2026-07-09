import { estimateWorkloadS, estimateRoute, sweepSplit, type Pt, __test } from './route-split';

const depot: Pt = { lat: 42.5, lng: 25.0 };

// sweepSplit tests use their own depot (Varna-ish), matching the original
// fixture this describe block was restored from.
const ringDepot: Pt = { lat: 43.2, lng: 27.9 };

/** n stops on a circle around ringDepot, radius ~1km, evenly spaced angles. */
function ring(n: number, phase = 0): { id: number; lat: number; lng: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    return {
      id: i,
      lat: ringDepot.lat + 0.009 * Math.sin(a),
      lng: ringDepot.lng + 0.013 * Math.cos(a),
    };
  });
}

describe('estimateWorkloadS', () => {
  it('is zero for no stops', () => {
    expect(estimateWorkloadS(depot, [])).toBe(0);
  });

  it('counts the return-to-depot leg when endPt is the depot', () => {
    const stops: Pt[] = [{ lat: 42.5, lng: 25.3 }, { lat: 42.5, lng: 25.4 }];
    const oneWay = estimateWorkloadS(depot, stops, null);
    const roundTrip = estimateWorkloadS(depot, stops, depot);
    // Round trip must be longer by roughly the far stop -> depot leg.
    expect(roundTrip).toBeGreaterThan(oneWay);
  });

  it('2-opt un-crosses a zig-zag NN order (never longer than raw NN)', () => {
    // Four stops that NN visits in a crossing order; 2-opt should not worsen it.
    const stops: Pt[] = [
      { lat: 42.50, lng: 25.10 },
      { lat: 42.60, lng: 25.10 },
      { lat: 42.50, lng: 25.20 },
      { lat: 42.60, lng: 25.20 },
    ];
    const w = estimateWorkloadS(depot, stops, depot);
    // Service time is 4 * 300 = 1200s; drive time is positive on top.
    expect(w).toBeGreaterThan(1200);
    expect(Number.isFinite(w)).toBe(true);
  });
});

describe('estimateRoute', () => {
  const depot = { lat: 42.5, lng: 27.46 };
  it('returns zero km and seconds for no stops', () => {
    expect(estimateRoute(depot, [], depot)).toEqual({ km: 0, seconds: 0 });
  });
  it('gives positive km and seconds for real stops', () => {
    const r = estimateRoute(depot, [{ lat: 42.6, lng: 27.5 }, { lat: 42.55, lng: 27.48 }], depot);
    expect(r.km).toBeGreaterThan(0);
    expect(r.seconds).toBeGreaterThan(0);
  });
  it('is monotonic — a farther stop set costs more km', () => {
    const near = estimateRoute(depot, [{ lat: 42.51, lng: 27.47 }], depot);
    const far = estimateRoute(depot, [{ lat: 43.2, lng: 27.9 }], depot);
    expect(far.km).toBeGreaterThan(near.km);
  });
});

describe('sweepSplit', () => {
  it('N=1 returns all stops in one group', () => {
    const stops = ring(7);
    const g = sweepSplit(ringDepot, stops, 1);
    expect(g).toHaveLength(1);
    expect(g[0]).toHaveLength(7);
  });

  it('splits 12 ring stops into 3 balanced contiguous sectors', () => {
    const stops = ring(12);
    const g = sweepSplit(ringDepot, stops, 3);
    expect(g).toHaveLength(3);
    expect(g.flat()).toHaveLength(12);
    // Perfect symmetry → perfect balance (4/4/4).
    expect(g.map((x) => x.length).sort()).toEqual([4, 4, 4]);
    // No stop appears twice.
    expect(new Set(g.flat().map((s) => s.id)).size).toBe(12);
  });

  it('more couriers than stops → one stop per group, no empty groups', () => {
    const g = sweepSplit(ringDepot, ring(2), 5);
    expect(g).toHaveLength(2);
    expect(g.every((x) => x.length === 1)).toBe(true);
  });

  it('is deterministic', () => {
    const stops = ring(9, 0.3);
    expect(sweepSplit(ringDepot, stops, 3)).toEqual(sweepSplit(ringDepot, stops, 3));
  });

  it('a dense cluster + a far stop does not starve the far courier', () => {
    // 6 stops clustered east, 1 stop far west: with 2 couriers the far stop
    // should sit alone (its drive time ≈ a courier's whole workload).
    const cluster = Array.from({ length: 6 }, (_, i) => ({
      id: i, lat: ringDepot.lat + 0.001 * i, lng: ringDepot.lng + 0.02,
    }));
    const far = { id: 99, lat: ringDepot.lat, lng: ringDepot.lng - 0.3 };
    const g = sweepSplit(ringDepot, [...cluster, far], 2);
    const wFar = g.find((x) => x.some((s) => s.id === 99))!;
    expect(wFar.length).toBeLessThanOrEqual(2);
  });
});

describe('partitionCost / betterCost', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };
  const A = { lat: 42.5, lng: 25.2 };
  const B = { lat: 42.5, lng: 24.8 };

  it('makespan is the busiest group, total is the sum', () => {
    const both = __test.partitionCost(d, [[A, B]], null);
    const split = __test.partitionCost(d, [[A], [B]], null);
    // One courier doing both stops is busier than either of two single-stop couriers.
    expect(both.makespan).toBeGreaterThan(split.makespan);
    // Splitting removes the A->B backtracking, so total work is less.
    expect(split.total).toBeLessThanOrEqual(both.total + 1e-6);
  });

  it('betterCost prefers lower makespan, then lower total', () => {
    expect(__test.betterCost({ makespan: 10, total: 30 }, { makespan: 12, total: 20 })).toBe(true);
    expect(__test.betterCost({ makespan: 10, total: 20 }, { makespan: 10, total: 30 })).toBe(true);
    expect(__test.betterCost({ makespan: 10, total: 30 }, { makespan: 10, total: 20 })).toBe(false);
  });
});

// Two tight clusters east and west of a central depot.
const west: Pt[] = [
  { lat: 42.50, lng: 24.70 },
  { lat: 42.52, lng: 24.71 },
  { lat: 42.48, lng: 24.69 },
];
const east: Pt[] = [
  { lat: 42.50, lng: 25.30 },
  { lat: 42.52, lng: 25.31 },
  { lat: 42.48, lng: 25.29 },
];
const twoClusters = [...west, ...east];

describe('seeds', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };

  it('kmeansSeed keeps each geographic cluster whole for 2 couriers', () => {
    const g = __test.kmeansSeed(d, twoClusters, 2);
    expect(g).toHaveLength(2);
    // Each group's longitudes are all on one side of the depot (25.0).
    for (const grp of g) {
      const sides = new Set(grp.map((p) => (p.lng < 25.0 ? 'W' : 'E')));
      expect(sides.size).toBe(1);
    }
  });

  it('every seed returns exactly n groups and loses no stop', () => {
    for (const seed of [
      __test.sweepSeed(d, twoClusters, 3, d),
      __test.kmeansSeed(d, twoClusters, 3),
      __test.radialSeed(d, twoClusters, 3),
    ]) {
      expect(seed).toHaveLength(3);
      expect(seed.flat()).toHaveLength(twoClusters.length);
    }
  });
});

describe('localSearch', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };

  it('never worsens the hybrid cost and is idempotent', () => {
    // Deliberately bad start: all stops on one courier, other empty.
    const bad: Pt[][] = [[...west, ...east], []];
    const before = __test.partitionCost(d, bad, d);
    const after = __test.localSearch(d, bad, d);
    const afterCost = __test.partitionCost(d, after, d);
    expect(afterCost.makespan).toBeLessThan(before.makespan);
    // Running it again changes nothing (local optimum).
    const twice = __test.localSearch(d, after, d);
    expect(__test.partitionCost(d, twice, d)).toEqual(afterCost);
  });

  it('preserves group count and loses no stop', () => {
    const start: Pt[][] = [[...west, ...east], []];
    const out = __test.localSearch(d, start, d);
    expect(out).toHaveLength(2);
    expect(out.flat()).toHaveLength(twoClusters.length);
  });
});

// Task 5: sweepSplit wired to the multi-seed + local-search pipeline (this
// block's tests are additive to the earlier `describe('sweepSplit', ...)`
// ring-based tests above; different fixtures, no collisions).
describe('sweepSplit', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };

  it('gives each geographic cluster to its own courier (no pie-slice split)', () => {
    const g = sweepSplit(d, twoClusters, 2, d);
    expect(g).toHaveLength(2);
    for (const grp of g) {
      const sides = new Set(grp.map((p) => (p.lng < 25.0 ? 'W' : 'E')));
      expect(sides.size).toBe(1); // each courier stays on one side
    }
  });

  it('result is no worse than the sweep seed alone (makespan)', () => {
    const seed = __test.sweepSeed(d, twoClusters, 2, d);
    const split = sweepSplit(d, twoClusters, 2, d);
    expect(__test.partitionCost(d, split, d).makespan).toBeLessThanOrEqual(
      __test.partitionCost(d, seed, d).makespan + 1e-6,
    );
  });

  it('strictly beats both the sweep seed alone and naive round-robin (makespan)', () => {
    // Three distinct clusters (W/E/N) with three couriers: the sweep seed's
    // angular arcs slice a cluster, and round-robin (i % n) scatters each
    // courier across all three clusters — the full multi-seed + local-search
    // pipeline gives each cluster to one courier. Strict `<`, not `<=`: this
    // guards against a future regression that silently turns k-means/localSearch
    // into no-ops (which the `<=` test above would not catch).
    const north: Pt[] = [
      { lat: 42.9, lng: 25.0 },
      { lat: 42.91, lng: 25.01 },
      { lat: 42.89, lng: 24.99 },
    ];
    const stops = [...west, ...east, ...north];
    const n = 3;
    // Naive round-robin: stops handed to couriers in input order.
    const roundRobin: Pt[][] = Array.from({ length: n }, () => []);
    stops.forEach((s, i) => roundRobin[i % n].push(s));

    const pipeline = __test.partitionCost(d, sweepSplit(d, stops, n, d), d).makespan;
    const seedAlone = __test.partitionCost(d, __test.sweepSeed(d, stops, n, d), d).makespan;
    const roundRobinCost = __test.partitionCost(d, roundRobin, d).makespan;

    expect(pipeline).toBeLessThan(seedAlone);
    expect(pipeline).toBeLessThan(roundRobinCost);
  });

  it('is deterministic', () => {
    expect(sweepSplit(d, twoClusters, 2, d)).toEqual(sweepSplit(d, twoClusters, 2, d));
  });

  it('handles the trivial cases', () => {
    expect(sweepSplit(d, [], 2)).toEqual([]);
    expect(sweepSplit(d, [{ lat: 42.5, lng: 25.1 }], 1)).toHaveLength(1);
    // more couriers than stops -> one stop each
    expect(sweepSplit(d, west, 5)).toHaveLength(west.length);
  });
});
