import { estimateWorkloadS, sweepSplit, type Pt } from './route-split';

const depot: Pt = { lat: 43.2, lng: 27.9 }; // Varna-ish

/** n stops on a circle around the depot, radius ~1km, evenly spaced angles. */
function ring(n: number, phase = 0): { id: number; lat: number; lng: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    return { id: i, lat: depot.lat + 0.009 * Math.sin(a), lng: depot.lng + 0.013 * Math.cos(a) };
  });
}

describe('estimateWorkloadS', () => {
  it('is zero for no stops and grows with stop count', () => {
    expect(estimateWorkloadS(depot, [])).toBe(0);
    const one = estimateWorkloadS(depot, ring(1));
    const four = estimateWorkloadS(depot, ring(4));
    expect(one).toBeGreaterThan(0);
    expect(four).toBeGreaterThan(one);
  });
});

describe('sweepSplit', () => {
  it('N=1 returns all stops in one group', () => {
    const stops = ring(7);
    const g = sweepSplit(depot, stops, 1);
    expect(g).toHaveLength(1);
    expect(g[0]).toHaveLength(7);
  });

  it('splits 12 ring stops into 3 balanced contiguous sectors', () => {
    const stops = ring(12);
    const g = sweepSplit(depot, stops, 3);
    expect(g).toHaveLength(3);
    expect(g.flat()).toHaveLength(12);
    // Perfect symmetry → perfect balance (4/4/4).
    expect(g.map((x) => x.length).sort()).toEqual([4, 4, 4]);
    // No stop appears twice.
    expect(new Set(g.flat().map((s) => s.id)).size).toBe(12);
  });

  it('more couriers than stops → one stop per group, no empty groups', () => {
    const g = sweepSplit(depot, ring(2), 5);
    expect(g).toHaveLength(2);
    expect(g.every((x) => x.length === 1)).toBe(true);
  });

  it('is deterministic', () => {
    const stops = ring(9, 0.3);
    expect(sweepSplit(depot, stops, 3)).toEqual(sweepSplit(depot, stops, 3));
  });

  it('a dense cluster + a far stop does not starve the far courier', () => {
    // 6 stops clustered east, 1 stop far west: with 2 couriers the far stop
    // should sit alone (its drive time ≈ a courier's whole workload).
    const cluster = Array.from({ length: 6 }, (_, i) => ({
      id: i, lat: depot.lat + 0.001 * i, lng: depot.lng + 0.02,
    }));
    const far = { id: 99, lat: depot.lat, lng: depot.lng - 0.3 };
    const g = sweepSplit(depot, [...cluster, far], 2);
    const wFar = g.find((x) => x.some((s) => s.id === 99))!;
    expect(wFar.length).toBeLessThanOrEqual(2);
  });
});
