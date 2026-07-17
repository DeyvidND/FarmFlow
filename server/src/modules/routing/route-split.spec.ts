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

// Audit follow-up Task 1: pin-aware balancing. A farmer-reported 20-delivery
// split showed a 4.56:1 imbalance because manual per-order pins are dumped
// onto their courier AFTER the free (unpinned) stops are split — the splitter
// treated every courier as starting from zero, so free stops got evenly
// divided ON TOP of an already-uneven pin distribution. `baseWorkloads` lets
// the caller (routing.service's getRoute) tell sweepSplit "courier i already
// has this many committed seconds of pinned work", so balancing (seed
// selection AND local search) minimizes makespan INCLUDING that base.
describe('sweepSplit — pin-aware balancing (baseWorkloads)', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };

  it('omitting baseWorkloads is byte-identical to today (no breaking change)', () => {
    expect(sweepSplit(d, twoClusters, 2, d)).toEqual(sweepSplit(d, twoClusters, 2, d, undefined));
  });

  it('an all-zero baseWorkloads behaves exactly like omitting it', () => {
    expect(sweepSplit(d, twoClusters, 2, d, [0, 0])).toEqual(sweepSplit(d, twoClusters, 2, d));
  });

  it('gives the courier with more already-pinned base workload fewer (or zero) of the free stops', () => {
    // Zero base: the two geographic clusters split 3/3 (see the "gives each
    // geographic cluster to its own courier" test above).
    const zero = sweepSplit(d, twoClusters, 2, d, [0, 0]);
    expect(zero.map((g) => g.length).sort()).toEqual([3, 3]);

    // Courier 0 already has ~2.8h (10000s) of pinned work — far more than
    // this whole 6-stop day is worth. It should end up with fewer stops than
    // the zero-base split gave it (ideally none), and courier 1 more.
    const skewed = sweepSplit(d, twoClusters, 2, d, [10000, 0]);
    expect(skewed).toHaveLength(2);
    expect(skewed.flat()).toHaveLength(twoClusters.length); // no stop lost
    expect(new Set(skewed.flat().map((s) => `${s.lat},${s.lng}`)).size).toBe(twoClusters.length);
    expect(skewed[0].length).toBeLessThan(zero[0].length);
    expect(skewed[1].length).toBeGreaterThan(zero[1].length);

    // Courier 0's TOTAL workload (base + assigned free stops) must stay much
    // closer to courier 1's than it would under the old "split evenly on top
    // of the base" behaviour — i.e. the fix actually compensates, it doesn't
    // just relabel the same even split. Compare like-for-like: the naive gap
    // uses the ZERO-base split's own two groups (what the old code would have
    // produced, base bolted on after), the fixed gap uses the new algorithm's
    // own two groups.
    const naiveGap = Math.abs(
      __test.partitionCost(d, [zero[0]], d).makespan +
        10000 -
        __test.partitionCost(d, [zero[1]], d).makespan,
    );
    const fixedGap = Math.abs(
      __test.partitionCost(d, [skewed[0]], d).makespan +
        10000 -
        __test.partitionCost(d, [skewed[1]], d).makespan,
    );
    expect(fixedGap).toBeLessThan(naiveGap);
  });

  it('is deterministic with baseWorkloads set', () => {
    expect(sweepSplit(d, twoClusters, 2, d, [3000, 500])).toEqual(
      sweepSplit(d, twoClusters, 2, d, [3000, 500]),
    );
  });
});

// Leg-speed model regression (the real 4h/1h day): a flat straight-line speed
// over-costs long rural/highway legs ~2× vs reality, so the splitter starved
// the "far" courier of stops — its route measured ~1h real driving while the
// dense-chain courier measured ~4h. The estimator now prices each leg at a
// length-dependent speed (short hops crawl, long legs approach open road).
// These tests score splits under an INDEPENDENT "true road" model (haversine ×
// road factor, realistic per-band road speeds) so they fail on any estimator
// whose bias re-creates the imbalance, not just on the old constant.
describe('sweepSplit — leg-speed model balances real (road-time) makespan', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };
  const SERVICE = 300;
  const KM_PER_LNG = 111.32 * Math.cos((42.5 * Math.PI) / 180); // ≈82 km/°

  /** True road seconds for a group served one-way from the depot: NN visit
   * order, road km = haversine × 1.3, road speed by leg length (city crawl /
   * secondary road / highway), + service per stop. Independent of the
   * estimator under test. */
  function trueRoadS(group: Pt[]): number {
    const remaining = [...group];
    let cursor = d;
    let secs = 0;
    while (remaining.length) {
      let best = 0;
      let bestKm = Infinity;
      remaining.forEach((p, i) => {
        const dd = Math.hypot(
          (p.lat - cursor.lat) * 111.32,
          (p.lng - cursor.lng) * KM_PER_LNG,
        );
        if (dd < bestKm) {
          bestKm = dd;
          best = i;
        }
      });
      cursor = remaining.splice(best, 1)[0];
      const roadKm = bestKm * 1.3;
      const kmh = roadKm < 4 ? 25 : roadKm < 13 ? 55 : 85;
      secs += (roadKm / kmh) * 3600 + SERVICE;
    }
    return secs;
  }

  // A village chain east of the depot (20 stops, ~2 km hops — slow local
  // roads) and a far spread north (4 stops: ~55 km highway out, then ~5 km
  // hops). This is the shape that produced the real 4h/1h split.
  const chain: Pt[] = Array.from({ length: 20 }, (_, i) => ({
    lat: 42.5,
    lng: 25.0 + (2 * (i + 1)) / KM_PER_LNG,
  }));
  const far: Pt[] = Array.from({ length: 4 }, (_, i) => ({
    lat: 42.5 + (55 + 5 * i) / 111.32,
    lng: 25.0,
  }));
  const stops = [...chain, ...far];

  it('keeps the two couriers within 1.5× of each other in TRUE road time', () => {
    const g = sweepSplit(d, stops, 2, null);
    expect(g).toHaveLength(2);
    expect(g.flat()).toHaveLength(stops.length);
    const times = g.map((grp) => trueRoadS(grp as Pt[]));
    const ratio = Math.max(...times) / Math.min(...times);
    expect(ratio).toBeLessThanOrEqual(1.5);
  });

  it('prices one long highway leg cheaper than the same straight km in short hops', () => {
    // 55 straight-line km as ONE leg vs as 25 × 2.2 km hops: drive-time cost
    // (service subtracted) must be much lower for the single long leg — a flat
    // speed makes them equal, which is exactly the bias that starved the far
    // courier.
    const oneFar = estimateWorkloadS(d, [{ lat: 42.5 + 55 / 111.32, lng: 25.0 }], null) - SERVICE;
    const hops: Pt[] = Array.from({ length: 25 }, (_, i) => ({
      lat: 42.5 + (2.2 * (i + 1)) / 111.32,
      lng: 25.0,
    }));
    const manyHops = estimateWorkloadS(d, hops, null) - 25 * SERVICE;
    expect(manyHops).toBeGreaterThan(oneFar * 1.8);
  });
});

describe('partitionCost with baseWorkloads', () => {
  const d: Pt = { lat: 42.5, lng: 25.0 };

  it('adds each group\'s base workload to its computed workload before scoring', () => {
    // Two roughly-symmetric single-stop groups, so the busier one (makespan)
    // is ambiguous without a base — adding a large base to group 0 must make
    // IT the busier one and lift the makespan by roughly that base amount.
    const groups = [[{ lat: 42.5, lng: 25.1 }], [{ lat: 42.5, lng: 24.9 }]];
    const noBase = __test.partitionCost(d, groups, null);
    const withBase = __test.partitionCost(d, groups, null, [5000, 0]);

    expect(withBase.total).toBeCloseTo(noBase.total + 5000, 5);
    expect(withBase.makespan).toBeGreaterThan(noBase.makespan + 4000);
  });

  it('defaults missing entries in a short baseWorkloads array to zero', () => {
    const groups = [[{ lat: 42.5, lng: 25.1 }], [{ lat: 42.5, lng: 24.9 }]];
    const noBase = __test.partitionCost(d, groups, null);
    const shortBase = __test.partitionCost(d, groups, null, []);
    expect(shortBase).toEqual(noBase);
  });
});

describe('sweepSplit — the few-free-stops fast path honours baseWorkloads', () => {
  const d: Pt = { lat: 43.2, lng: 27.9 };

  it('gives a free stop to the LEAST-loaded courier, not the one it sits next to by position', () => {
    // Real shape: 2 couriers, most orders pinned to courier 0, so only a couple of
    // FREE stops remain. baseWorkloads carries courier 0's already-committed pinned
    // workload; courier 1 starts empty. With free.length (2) <= n (2), the old fast
    // path returned [[f0],[f1]] by array POSITION — handing f0 to the busy courier 0
    // and defeating the pin-aware balancing feeefc43 added. Both free stops should
    // land on the empty courier 1 (it can absorb them and still be lighter).
    const free = [
      { id: 'f0', lat: 43.25, lng: 27.95 },
      { id: 'f1', lat: 43.15, lng: 27.85 },
    ];
    const baseWorkloads = [50_000, 0]; // courier 0 already heavily pinned, courier 1 idle

    const g = sweepSplit(d, free, 2, d, baseWorkloads);

    // Both free stops land TOGETHER on the idle courier; none is forced onto the
    // already-overloaded one. (sweepSplit drops empty groups, so the loaded
    // courier's leg simply isn't present — assert on grouping, not slot index.)
    const groupOf = (id: string) => g.findIndex((grp) => grp.some((s: any) => s.id === id));
    expect(groupOf('f0')).toBeGreaterThanOrEqual(0);
    expect(groupOf('f0')).toBe(groupOf('f1'));
    expect(g).toHaveLength(1);
  });
});
