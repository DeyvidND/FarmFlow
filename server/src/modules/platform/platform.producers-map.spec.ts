/**
 * Unit test for PlatformService.producersMap() — the cross-tenant „карта на
 * производители" pins (task #12). Coordinates come from `farmers.lat/lng`
 * (numeric columns, so they arrive as string|null); rows still missing them
 * are geocoded on read via MapsService.geocodeApprox and persisted so the
 * next read skips the geocode. Maps disabled / a geocode miss just leaves the
 * pin null — it never throws.
 *
 * Constructed via `new PlatformService(...)` directly (not the Nest testing
 * module) — every dependency but `db` and `maps` is irrelevant to this method,
 * so they're stubbed with `{} as never` per the task brief.
 */
import { PlatformService } from './platform.service';

/** Chainable select mock: select().from().innerJoin().orderBy().limit() resolves
 *  to `rows`. A separate update().set().where() chain resolves to undefined and is
 *  spied on. */
function makeDb(rows: unknown[]) {
  const selectChain: any = {
    from: jest.fn(() => selectChain),
    innerJoin: jest.fn(() => selectChain),
    orderBy: jest.fn(() => selectChain),
    limit: jest.fn(() => Promise.resolve(rows)),
  };
  const updateWhere = jest.fn(() => Promise.resolve(undefined));
  const updateSet = jest.fn(() => ({ where: updateWhere }));
  const update = jest.fn(() => ({ set: updateSet }));
  const db: any = {
    select: jest.fn(() => selectChain),
    update,
  };
  return { db, update, updateSet, updateWhere };
}

function producerRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'f1',
    name: 'Ферма 1',
    city: 'Варна',
    legal: null,
    tint: null,
    imageUrl: null,
    tier: 'starter',
    lat: null,
    lng: null,
    tenantName: 'Тенант 1',
    tenantSlug: 't1',
    isDemo: false,
    ...over,
  };
}

function makeSvc(db: unknown, maps: unknown) {
  return new PlatformService(
    db as never,
    {} as never, // jwt
    {} as never, // auth
    {} as never, // billing
    {} as never, // publicCache
    {} as never, // config
    {} as never, // productsSvc
    {} as never, // farmersSvc
    {} as never, // subcategoriesSvc
    {} as never, // tenantsSvc
    {} as never, // storage
    {} as never, // catalogCache
    maps as never,
  );
}

describe('PlatformService.producersMap()', () => {
  it('keeps existing lat/lng (as numeric strings) without geocoding', async () => {
    const row = producerRow({ id: 'f1', lat: '43.2', lng: '27.9' });
    const { db } = makeDb([row]);
    const geocodeApprox = jest.fn();
    const svc = makeSvc(db, { enabled: true, geocodeApprox });

    const res = await svc.producersMap();

    expect(res.producers).toHaveLength(1);
    expect(res.producers[0].lat).toBe(43.2);
    expect(res.producers[0].lng).toBe(27.9);
    expect(res.withLocation).toBe(1);
    expect(res.withoutLocation).toBe(0);
    expect(geocodeApprox).not.toHaveBeenCalled();
  });

  it('geocodes a coordless producer with a city and persists the result', async () => {
    const row = producerRow({ id: 'f2', city: 'Варна', lat: null, lng: null });
    const { db, update } = makeDb([row]);
    const geocodeApprox = jest.fn().mockResolvedValue({ lat: 43.2, lng: 27.9 });
    const svc = makeSvc(db, { enabled: true, geocodeApprox });

    const res = await svc.producersMap();

    expect(geocodeApprox).toHaveBeenCalledWith('Варна');
    expect(res.producers[0].lat).toBe(43.2);
    expect(res.producers[0].lng).toBe(27.9);
    expect(res.withLocation).toBe(1);
    expect(update).toHaveBeenCalled();
  });

  it('leaves a coordless producer without location when maps are disabled, and does not throw', async () => {
    const row = producerRow({ id: 'f3', city: 'Пловдив', lat: null, lng: null });
    const { db, update } = makeDb([row]);
    const geocodeApprox = jest.fn();
    const svc = makeSvc(db, { enabled: false, geocodeApprox });

    const res = await svc.producersMap();

    expect(geocodeApprox).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(res.producers[0].lat).toBeNull();
    expect(res.producers[0].lng).toBeNull();
    expect(res.withoutLocation).toBe(1);
    expect(res.mapsEnabled).toBe(false);
  });
});
