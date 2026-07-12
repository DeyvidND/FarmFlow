import {
  greedyByDistance,
  endPoint,
  ptOf,
  effectiveCourierCount,
  resolveCourierModes,
  parseEndModes,
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

describe('effectiveCourierCount', () => {
  it('defaults to 1 when omitted', () => {
    expect(effectiveCourierCount(undefined)).toBe(1);
  });
  it('passes through a valid count', () => {
    expect(effectiveCourierCount(3)).toBe(3);
  });
  it('clamps to [1,10] and floors', () => {
    expect(effectiveCourierCount(0)).toBe(1);
    expect(effectiveCourierCount(99)).toBe(10);
    expect(effectiveCourierCount(2.9)).toBe(2);
  });
  it('falls back to 1 for NaN', () => {
    expect(effectiveCourierCount(Number.NaN)).toBe(1);
  });
});

describe('resolveCourierModes', () => {
  it('fills all couriers with the default when no per-courier array', () => {
    expect(resolveCourierModes('home', undefined, 3)).toEqual(['home', 'home', 'home']);
  });
  it('applies per-courier overrides by index', () => {
    expect(resolveCourierModes('home', ['last', undefined, 'home'], 3)).toEqual(['last', 'home', 'home']);
  });
  it('falls back to the default for missing / undefined slots and truncates extras', () => {
    expect(resolveCourierModes('last', ['home'], 3)).toEqual(['home', 'last', 'last']);
    expect(resolveCourierModes('home', ['last', 'last', 'last', 'last'], 2)).toEqual(['last', 'last']);
  });
});

describe('parseEndModes', () => {
  it('returns undefined for empty / missing input', () => {
    expect(parseEndModes(undefined)).toBeUndefined();
    expect(parseEndModes('')).toBeUndefined();
  });
  it('parses valid modes and maps invalid / blank tokens to undefined', () => {
    expect(parseEndModes('home,last,home')).toEqual(['home', 'last', 'home']);
    expect(parseEndModes('home,bogus,,last')).toEqual(['home', undefined, undefined, 'last']);
  });
});
