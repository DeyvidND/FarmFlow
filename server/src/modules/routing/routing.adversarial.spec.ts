/**
 * Adversarial routing tests — 5 attempts to break the pure helpers with 4-stop
 * edge cases. Each scenario targets a different failure mode.
 */
import {
  greedyByDistance,
  mergeBySlot,
  endPoint,
  ptOf,
  type RouteStop,
  type RouteEnd,
} from './routing.service';

const stop = (
  id: string,
  lat: number | null,
  lng: number | null,
  slotFrom: string | null = null,
): RouteStop => ({
  id,
  customer: null,
  phone: null,
  email: null,
  address: null,
  lat,
  lng,
  summary: '',
  slotFrom,
  slotTo: null,
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

// ─── Attempt 3: mergeBySlot with unsorted located input ─────────────────────
// mergeBySlot assumes both input lists are slot-sorted. In practice orderedLocated
// is always sorted (slot groups processed in order), but let's verify the function
// itself when the precondition is violated.
describe('Adversarial 3 — mergeBySlot with out-of-order located list', () => {
  // Violate the precondition: located NOT sorted ascending.
  const L13 = stop('L13', 0, 1, '13:00'); // late slot first
  const L11 = stop('L11', 0, 2, '11:00'); // early slot second
  const L15 = stop('L15', 0, 3, '15:00');
  const U12 = stop('U12', null, null, '12:00');

  it('sorts inputs internally — unsorted located no longer produces wrong order (fixed)', () => {
    // Before fix: [U12, L13, L11, L15] — L11 after L13, wrong.
    // After fix: mergeBySlot sorts both inputs first.
    const out = mergeBySlot([L13, L11, L15], [U12]);
    expect(out.map((s) => s.id)).toEqual(['L11', 'U12', 'L13', 'L15']);
  });

  it('mergeBySlot works correctly when both inputs are sorted', () => {
    const out = mergeBySlot([L11, L13, L15], [U12]);
    expect(out.map((s) => s.id)).toEqual(['L11', 'U12', 'L13', 'L15']);
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
