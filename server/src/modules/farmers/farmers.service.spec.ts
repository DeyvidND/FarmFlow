import { FarmersService } from './farmers.service';

/** Chainable Drizzle mock for FarmersService.update: builder methods return `this`;
 *  `limit()`/`returning()` resolve whatever was queued via mockResolvedValueOnce.
 *  `transaction()` runs the callback against this same mock, so
 *  `tx.update().set().where().returning()` calls land on the same jest.fn()s the
 *  test inspects. */
function makeDb() {
  const db: any = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
  };
  return db;
}

/** Thenable chainable Drizzle mock matching farmers.public-fields.spec.ts: builder
 *  methods return `this`; awaiting the chain resolves the next queued value (FIFO).
 *  findPublicBySlug awaits several distinct `select()...` chains in sequence, none
 *  of which need a per-call resolved value — just the next item off the queue. */
function makePublicDb() {
  const queue: unknown[] = [];
  const db: any = {
    queue: (v: unknown) => queue.push(v),
  };
  const chain = () => db;
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) {
    db[m] = jest.fn(chain);
  }
  db.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    const v = queue.shift();
    if (v instanceof Error) reject(v);
    else resolve(v);
  };
  return db;
}

function makeSvc(db: any, mapsEnabled: boolean, geocodeApprox = jest.fn()) {
  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const publicCache = {
    del: jest.fn().mockResolvedValue(undefined),
    resolveTenant: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
  };
  const maps = { enabled: mapsEnabled, geocodeApprox };
  return new FarmersService(db, {} as any, cache as any, publicCache as any, {} as any, {} as any, maps as any);
}

const TENANT = 'tenant-1';
const FARMER = 'farmer-1';

describe('FarmersService.update — geocode-on-address-change', () => {
  it('changed city → geocodeApprox called once, coords + geocodedAt persisted', async () => {
    const db = makeDb();
    const geocodeApprox = jest.fn().mockResolvedValue({ lat: 43.2141, lng: 27.9147 });
    db.limit.mockResolvedValueOnce([{ city: 'Стара Загора', legal: null }]); // loc pre-read (outside tx)
    db.limit.mockResolvedValueOnce([{ tier: 1, branding: null }]); // tier/branding read (inside tx)
    db.returning.mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, city: 'Варна', tier: 1 }]); // tx write

    const svc = makeSvc(db, true, geocodeApprox);
    await svc.update(FARMER, TENANT, { city: 'Варна' } as any);

    expect(geocodeApprox).toHaveBeenCalledTimes(1);
    expect(geocodeApprox).toHaveBeenCalledWith('Варна');
    const setArg = db.set.mock.calls[0][0];
    expect(setArg.lat).toBe('43.2141');
    expect(setArg.lng).toBe('27.9147');
    expect(setArg.geocodedAt).toBeInstanceOf(Date);
  });

  it('unrelated field update (bio) with unchanged city/address → geocodeApprox NOT called', async () => {
    const db = makeDb();
    const geocodeApprox = jest.fn();
    db.limit.mockResolvedValueOnce([{ city: 'Стара Загора', legal: null }]);
    db.limit.mockResolvedValueOnce([{ tier: 1, branding: null }]);
    db.returning.mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, bio: 'ново' }]);

    const svc = makeSvc(db, true, geocodeApprox);
    await svc.update(FARMER, TENANT, { bio: 'ново' } as any);

    expect(geocodeApprox).not.toHaveBeenCalled();
    const setArg = db.set.mock.calls[0][0];
    expect(setArg).not.toHaveProperty('lat');
    expect(setArg).not.toHaveProperty('lng');
    expect(setArg).not.toHaveProperty('geocodedAt');
  });

  it('manual lat/lng override → geocodeApprox skipped, override values stored as strings', async () => {
    const db = makeDb();
    const geocodeApprox = jest.fn();
    db.limit.mockResolvedValueOnce([{ city: 'Варна', legal: null }]);
    db.limit.mockResolvedValueOnce([{ tier: 1, branding: null }]);
    db.returning.mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT }]);

    const svc = makeSvc(db, true, geocodeApprox);
    await svc.update(FARMER, TENANT, { lat: 43.5, lng: 27.1 } as any);

    expect(geocodeApprox).not.toHaveBeenCalled();
    const setArg = db.set.mock.calls[0][0];
    expect(setArg.lat).toBe('43.5');
    expect(setArg.lng).toBe('27.1');
    expect(setArg.geocodedAt).toBeInstanceOf(Date);
    // never spreads the raw numeric override into the update set
    expect(typeof setArg.lat).toBe('string');
    expect(typeof setArg.lng).toBe('string');
  });

  it('geocodeApprox returns null → existing lat/lng/geocodedAt are left untouched', async () => {
    const db = makeDb();
    const geocodeApprox = jest.fn().mockResolvedValue(null);
    db.limit.mockResolvedValueOnce([{ city: 'Стара Загора', legal: null }]);
    db.limit.mockResolvedValueOnce([{ tier: 1, branding: null }]);
    db.returning.mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, city: 'Бургас' }]);

    const svc = makeSvc(db, true, geocodeApprox);
    await svc.update(FARMER, TENANT, { city: 'Бургас' } as any);

    expect(geocodeApprox).toHaveBeenCalledTimes(1);
    const setArg = db.set.mock.calls[0][0];
    // A transient miss must not null out an already-good pin — the update set simply
    // omits the coord fields, leaving the stored row's lat/lng/geocodedAt as-is.
    expect(setArg).not.toHaveProperty('lat');
    expect(setArg).not.toHaveProperty('lng');
    expect(setArg).not.toHaveProperty('geocodedAt');
  });
});

describe('FarmersService.findPublicBySlug — lat/lng projection', () => {
  it('includes numeric lat/lng and excludes geocodedAt/commissionRateBps/internalNotes/payout', async () => {
    const db = makePublicDb();
    const row = {
      id: 'f1', tenantId: TENANT, name: 'Васил', role: null, bio: null,
      phone: null, email: null, since: null, city: 'Варна', tint: null, imageUrl: null,
      coverCrop: null, legal: null, story: null, position: 0, createdAt: new Date(),
      commissionRateBps: 500, subscriptionFeeStotinki: 1200,
      internalNotes: 'таен коментар', payout: { iban: 'BG80BNBG96611020345678', holder: 'Васил' },
      lat: '43.2141', lng: '27.9147',
    };
    // Call order inside findPublicBySlug: farmers rows → mediaUrlsByFarmer rows
    // (private helper, one query) → tenant.settings row (for courier-eligibility).
    db.queue([row]);
    db.queue([]);
    db.queue([{ settings: null }]);

    const publicCache = {
      resolveTenant: jest.fn().mockResolvedValue({ id: TENANT, multiFarmer: true }),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new FarmersService(
      db as any, {} as any, {} as any, publicCache as any, {} as any, {} as any,
      { enabled: false, geocodeApprox: jest.fn() } as any,
    );

    const [out] = await svc.findPublicBySlug('chaika');

    expect(out.lat).toBe(43.2141);
    expect(out.lng).toBe(27.9147);
    expect(typeof out.lat).toBe('number');
    expect(out).not.toHaveProperty('geocodedAt');
    expect(out).not.toHaveProperty('commissionRateBps');
    expect(out).not.toHaveProperty('subscriptionFeeStotinki');
    expect(out).not.toHaveProperty('internalNotes');
    expect(out).not.toHaveProperty('payout');
  });

  it('maps a null lat/lng to null (no pin yet), not 0 or NaN', async () => {
    const db = makePublicDb();
    const row = {
      id: 'f1', tenantId: TENANT, name: 'Васил', role: null, bio: null,
      phone: null, email: null, since: null, city: null, tint: null, imageUrl: null,
      coverCrop: null, legal: null, story: null, position: 0, createdAt: new Date(),
      commissionRateBps: null, subscriptionFeeStotinki: null,
      internalNotes: null, payout: null, lat: null, lng: null,
    };
    db.queue([row]);
    db.queue([]);
    db.queue([{ settings: null }]);

    const publicCache = {
      resolveTenant: jest.fn().mockResolvedValue({ id: TENANT, multiFarmer: true }),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new FarmersService(
      db as any, {} as any, {} as any, publicCache as any, {} as any, {} as any,
      { enabled: false, geocodeApprox: jest.fn() } as any,
    );

    const [out] = await svc.findPublicBySlug('chaika');

    expect(out.lat).toBeNull();
    expect(out.lng).toBeNull();
  });
});
