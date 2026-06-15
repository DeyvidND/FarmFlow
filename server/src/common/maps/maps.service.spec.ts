import { MapsService } from './maps.service';

// PublicCacheService stub: always a miss, swallow writes — exercises the live
// (non-cached) path on every call.
const cacheStub = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
} as never;

const make = (key: string) => new MapsService({ get: () => key } as never, cacheStub);

/** Replace global.fetch with a mock returning `json`; return the captured calls. */
function mockFetch(json: unknown) {
  const calls: { url: string; body: any }[] = [];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(
    async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => json } as unknown as Response;
    },
  );
  return calls;
}

/** fetch mock that returns successive `jsons` (last repeats) — for retry paths. */
function mockFetchSeq(jsons: unknown[]) {
  const calls: { url: string }[] = [];
  let i = 0;
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
    calls.push({ url });
    const json = jsons[Math.min(i, jsons.length - 1)];
    i += 1;
    return { ok: true, json: async () => json } as unknown as Response;
  });
  return calls;
}

const geoOk = (lat: number, lng: number, types: string[] = ['street_address']) => ({
  status: 'OK',
  results: [{ types, geometry: { location: { lat, lng } } }],
});
const geoZero = { status: 'ZERO_RESULTS', results: [] };

const origin = { lat: 42.0, lng: 23.0 };
const stops = [
  { lat: 42.1, lng: 23.1 },
  { lat: 42.2, lng: 23.2 },
];

afterEach(() => jest.clearAllMocks());

describe('MapsService disabled (no API key)', () => {
  it('route/geocode/routeFixed all resolve to null and never call fetch', async () => {
    const fetchSpy = mockFetch({});
    const svc = make('');
    expect(svc.enabled).toBe(false);
    expect(await svc.route(origin, stops)).toBeNull();
    expect(await svc.geocode('ул. Шипка 5')).toBeNull();
    expect(await svc.routeFixed([origin, ...stops])).toBeNull();
    expect(fetchSpy).toHaveLength(0);
  });
});

describe('MapsService.route destination handling', () => {
  const okRoute = {
    routes: [{ distanceMeters: 1234, duration: '600s', optimizedIntermediateWaypointIndex: [1, 0] }],
  };

  it('no destination → optimizes a loop back to the origin', async () => {
    const calls = mockFetch(okRoute);
    const plan = await make('k').route(origin, stops);
    expect(plan).toEqual({ distanceM: 1234, durationS: 600, order: [1, 0] });
    const body = calls[0].body;
    expect(body.origin.location.latLng).toEqual({ latitude: 42.0, longitude: 23.0 });
    expect(body.destination.location.latLng).toEqual({ latitude: 42.0, longitude: 23.0 });
    expect(body.optimizeWaypointOrder).toBe(true);
    expect(body.intermediates).toHaveLength(2);
  });

  it('explicit destination → optimizes toward THAT point (one-way / custom end)', async () => {
    const calls = mockFetch(okRoute);
    const dest = { lat: 43.5, lng: 24.5 };
    await make('k').route(origin, stops, dest);
    expect(calls[0].body.destination.location.latLng).toEqual({ latitude: 43.5, longitude: 24.5 });
  });

  it('rejects a non-permutation optimized index and keeps input order', async () => {
    mockFetch({ routes: [{ distanceMeters: 10, duration: '5s', optimizedIntermediateWaypointIndex: [-1] }] });
    const plan = await make('k').route(origin, stops);
    expect(plan?.order).toEqual([0, 1]);
  });

  it('returns null when the API yields no route', async () => {
    mockFetch({ error: { status: 'INVALID_ARGUMENT' } });
    expect(await make('k').route(origin, stops)).toBeNull();
  });
});

describe('MapsService.geocode', () => {
  it('adds locality + postal_code component filters when supplied', async () => {
    const calls = mockFetch(geoOk(43.2, 27.9));
    const out = await make('k').geocode('ул. Иван Вазов 5', undefined, {
      locality: 'Варна',
      postalCode: '9000',
    });
    expect(out).toEqual({ lat: 43.2, lng: 27.9 });
    const url = decodeURIComponent(calls[0].url);
    expect(url).toContain('country:BG');
    expect(url).toContain('locality:Варна');
    expect(url).toContain('postal_code:9000');
  });

  it('retries country-only when the component filter over-filters to zero', async () => {
    const calls = mockFetchSeq([geoZero, geoOk(43.2, 27.9)]);
    const out = await make('k').geocode('ул. Иван Вазов 5', undefined, { locality: 'Варна-typo' });
    expect(out).toEqual({ lat: 43.2, lng: 27.9 });
    expect(calls).toHaveLength(2);
    expect(decodeURIComponent(calls[0].url)).toContain('locality:');
    expect(decodeURIComponent(calls[1].url)).not.toContain('locality:');
  });

  it('caches a successful result — a repeat resolve does not re-fetch', async () => {
    const store = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: unknown) => void store.set(k, v)),
    } as never;
    const svc = new MapsService({ get: () => 'k' } as never, cache);
    const calls = mockFetch(geoOk(42.5, 25.5));
    const first = await svc.geocode('пл. Свобода 1', { lat: 42.5, lng: 25.5 });
    const second = await svc.geocode('пл. Свобода 1', { lat: 42.5, lng: 25.5 });
    expect(first).toEqual({ lat: 42.5, lng: 25.5 });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1); // second served from cache
  });

  it('drops a too-coarse country-centroid match', async () => {
    const calls = mockFetch(geoOk(42.7, 25.4, ['country']));
    expect(await make('k').geocode('гибериш', undefined, {})).toBeNull();
    expect(calls).toHaveLength(1); // components already country-only → no retry
  });

  it('rejects a town-centre (locality) centroid — a gibberish street must not pin to the city centre', async () => {
    // With a locality component, Google falls back to the town centre for an
    // unmatchable street (types=['locality']). That is not street-precise → null
    // (then a country-only retry, which here also yields the same coarse match).
    const calls = mockFetchSeq([geoOk(43.21, 27.91, ['locality', 'political'])]);
    expect(await make('k').geocode('пълни глупости 123', undefined, { locality: 'Варна' })).toBeNull();
    expect(calls).toHaveLength(2); // attempt with locality → coarse → country-only retry
  });

  it('keeps a street-precise (route) match — many rural BG addresses resolve only to street level', async () => {
    mockFetch(geoOk(43.0, 25.6, ['route']));
    expect(await make('k').geocode('ул. Дунав, някое село', undefined, { locality: 'Севлиево' })).toEqual({
      lat: 43.0,
      lng: 25.6,
    });
  });

  it('keeps a neighbourhood (sublocality) match — a real district beats a precise match in the wrong town', async () => {
    // кв. Чайка resolves to a sublocality centroid in the RIGHT place; dropping it
    // (as a too-strict street-only rule would) sent the retry to a same-named
    // street ~38km away. A finer-than-town type must be kept.
    mockFetch(geoOk(43.2146, 27.9408, ['sublocality', 'sublocality_level_1', 'political']));
    expect(
      await make('k').geocode('ул. Цар Освободител 12, кв. Чайка, Варна', { lat: 43.21, lng: 27.91 }, { locality: 'Варна' }),
    ).toEqual({ lat: 43.2146, lng: 27.9408 });
  });
});

describe('MapsService.routeFixed', () => {
  it('sends first as origin, last as destination, the rest as intermediates', async () => {
    const calls = mockFetch({ routes: [{ distanceMeters: 5000, duration: '900s' }] });
    const pts = [origin, ...stops, { lat: 42.3, lng: 23.3 }];
    const out = await make('k').routeFixed(pts);
    expect(out).toEqual({ distanceM: 5000, durationS: 900 });
    const body = calls[0].body;
    expect(body.origin.location.latLng).toEqual({ latitude: 42.0, longitude: 23.0 });
    expect(body.destination.location.latLng).toEqual({ latitude: 42.3, longitude: 23.3 });
    expect(body.intermediates).toHaveLength(2);
    expect(body.optimizeWaypointOrder).toBeUndefined();
  });
});
