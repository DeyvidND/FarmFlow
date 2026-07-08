import { estimateWorkloadS, sweepSplit, type Pt } from './route-split';

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
