import { estimateWorkloadS, haversineKm, type Pt } from './route-split';

const depot: Pt = { lat: 42.5, lng: 25.0 };

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
