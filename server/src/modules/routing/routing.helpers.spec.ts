import {
  greedyByDistance,
  endPoint,
  ptOf,
  mergeBySlot,
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

describe('ptOf', () => {
  it('returns coords when geocoded, null otherwise', () => {
    expect(ptOf(stop('a', 42, 23))).toEqual({ lat: 42, lng: 23 });
    expect(ptOf(stop('b', null, 23))).toBeNull();
    expect(ptOf(stop('c', 42, null))).toBeNull();
  });
});

describe('endPoint', () => {
  const origin = { lat: 42, lng: 23 };

  it('home → loops back to the depot', () => {
    expect(endPoint('home', origin, { mode: 'home', address: 'x', lat: 42, lng: 23 })).toEqual(origin);
  });

  it('custom with coords → the saved end point', () => {
    const end: RouteEnd = { mode: 'custom', address: 'край', lat: 43.5, lng: 24.5 };
    expect(endPoint('custom', origin, end)).toEqual({ lat: 43.5, lng: 24.5 });
  });

  it('custom without coords → null (loop fallback)', () => {
    const end: RouteEnd = { mode: 'custom', address: 'край', lat: null, lng: null };
    expect(endPoint('custom', origin, end)).toBeNull();
  });

  it('last (one-way) → null, no fixed end', () => {
    expect(endPoint('last', origin, { mode: 'last', address: null, lat: null, lng: null })).toBeNull();
  });
});

describe('greedyByDistance', () => {
  // Stops strung along a line east of the origin at distances 3, 1, 2.
  const origin = { lat: 0, lng: 0 };
  const a = stop('a', 0, 3);
  const b = stop('b', 0, 1);
  const c = stop('c', 0, 2);

  it('orders nearest-neighbour from the depot, not input order', () => {
    const out = greedyByDistance(origin, [a, b, c]);
    expect(out.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('chains from the cursor (not the depot) for each subsequent pick', () => {
    // Starting at the far stop, nearest is the next-closest, then the closest.
    const out = greedyByDistance({ lat: 0, lng: 3 }, [b, c, a]);
    expect(out.map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('places un-geocoded stops last', () => {
    const noCoords = stop('z', null, null);
    const out = greedyByDistance(origin, [noCoords, a, b]);
    expect(out.map((s) => s.id)).toEqual(['b', 'a', 'z']);
  });

  it('with no start point keeps the first stop, then nearest-neighbours', () => {
    const out = greedyByDistance(null, [a, b, c]);
    // No depot → first pick is input[0] (a, dist 3), then nearest is c (2), then b.
    expect(out.map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the input array', () => {
    const input = [a, b, c];
    greedyByDistance(origin, input);
    expect(input.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeBySlot', () => {
  it('weaves an un-geocoded stop into its slot position, not the end', () => {
    const located = [stop('L1', 0, 1, '11:00'), stop('L2', 0, 2, '13:00')];
    const unlocated = [stop('U', null, null, '12:00')];
    expect(mergeBySlot(located, unlocated).map((s) => s.id)).toEqual(['L1', 'U', 'L2']);
  });

  it('located stop wins a same-slot tie (it has a fixed position)', () => {
    const located = [stop('L', 0, 1, '11:00')];
    const unlocated = [stop('U', null, null, '11:00')];
    expect(mergeBySlot(located, unlocated).map((s) => s.id)).toEqual(['L', 'U']);
  });

  it('a slotless un-geocoded stop still sorts last', () => {
    const located = [stop('L', 0, 1, '11:00')];
    const unlocated = [stop('U', null, null, null)];
    expect(mergeBySlot(located, unlocated).map((s) => s.id)).toEqual(['L', 'U']);
  });
});
