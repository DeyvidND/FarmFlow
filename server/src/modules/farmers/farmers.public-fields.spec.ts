import { FarmersService } from './farmers.service';

/** Thenable chainable Drizzle mock: builder methods return `this`; awaiting the
 *  chain resolves the next queued value (FIFO). Matches the pattern used by
 *  farmers.access.spec.ts but adds a `queue` helper since findPublicBySlug
 *  awaits several distinct `select()...` chains in sequence. */
function makeDb() {
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

const TENANT = 'tenant-1';

describe('FarmersService public payload', () => {
  it('strips vendor-finance fields, keeps phone/email, and caches the stripped shape', async () => {
    const db = makeDb();
    const legal = { kind: 'sole_trader' as const, name: 'ЕТ Васил', eik: '203912345' };
    const row = {
      id: 'f1', tenantId: TENANT, name: 'Васил', role: 'Ягодоплодни', bio: null,
      phone: '0888', email: 'v@x.bg', since: '2023', tint: null, imageUrl: null,
      coverCrop: null, legal, story: 'Дълъг разказ', position: 0, createdAt: new Date(),
      commissionRateBps: 500, subscriptionFeeStotinki: 1200,
      internalNotes: 'таен коментар', payout: { iban: 'BG80BNBG96611020345678', holder: 'Васил' },
    };
    // Call order inside findPublicBySlug: farmers rows → mediaUrlsByFarmer rows
    // (private helper, one query) → tenant.settings row (for courier-eligibility).
    db.queue([row]); // farmers rows
    db.queue([]); // mediaUrlsByFarmer: no gallery photos for f1
    db.queue([{ settings: null }]); // tenant settings row

    const publicCache = {
      resolveTenant: jest.fn().mockResolvedValue({ id: TENANT, multiFarmer: true }),
      get: jest.fn().mockResolvedValue(null), // cache miss → hits the DB path above
      set: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new FarmersService(db as any, {} as any, {} as any, publicCache as any, {} as any, {} as any);

    const out = await svc.findPublicBySlug('chaika');

    expect(out).toHaveLength(1);
    for (const f of out) {
      expect(f).not.toHaveProperty('commissionRateBps');
      expect(f).not.toHaveProperty('subscriptionFeeStotinki');
      // public on purpose (product decision 2026-07-02) — must survive the strip
      expect(f).toHaveProperty('phone', '0888');
      expect(f).toHaveProperty('email', 'v@x.bg');
      // legal seller identity is REQUIRED public КЗП disclosure — must survive too
      expect(f).toHaveProperty('legal', legal);
      // „За фермата" public story survives the projection
      expect(f).toHaveProperty('story', 'Дълъг разказ');
      // operator-only fields must be stripped
      expect(f).not.toHaveProperty('internalNotes');
      expect(f).not.toHaveProperty('payout');
    }

    // The strip must happen BEFORE the cache write — otherwise a stale cached
    // payload would keep leaking the finance fields even after this fix.
    expect(publicCache.set).toHaveBeenCalledTimes(1);
    const cached = publicCache.set.mock.calls[0][1] as Record<string, unknown>[];
    for (const f of cached) {
      expect(f).not.toHaveProperty('commissionRateBps');
      expect(f).not.toHaveProperty('subscriptionFeeStotinki');
      expect(f).not.toHaveProperty('internalNotes');
      expect(f).not.toHaveProperty('payout');
    }
  });

  it('short-circuits to [] without a db read when multiFarmer is off', async () => {
    const db = makeDb();
    const publicCache = {
      resolveTenant: jest.fn().mockResolvedValue({ id: TENANT, multiFarmer: false }),
      get: jest.fn(),
      set: jest.fn(),
    };
    const svc = new FarmersService(db as any, {} as any, {} as any, publicCache as any, {} as any, {} as any);

    const out = await svc.findPublicBySlug('chaika');

    expect(out).toEqual([]);
    expect(publicCache.get).not.toHaveBeenCalled();
  });

  it('serves a warm cache hit as-is (already stripped at write time)', async () => {
    const db = makeDb();
    const cachedPayload = [
      { id: 'f1', tenantId: TENANT, name: 'Васил', phone: '0888', email: 'v@x.bg' },
    ];
    const publicCache = {
      resolveTenant: jest.fn().mockResolvedValue({ id: TENANT, multiFarmer: true }),
      get: jest.fn().mockResolvedValue(cachedPayload),
      set: jest.fn(),
    };
    const svc = new FarmersService(db as any, {} as any, {} as any, publicCache as any, {} as any, {} as any);

    const out = await svc.findPublicBySlug('chaika');

    expect(out).toBe(cachedPayload);
    expect(publicCache.set).not.toHaveBeenCalled();
  });

  it('leaves the admin/owner path (findAll) unstripped — the panel still needs the finance fields', async () => {
    const db = makeDb();
    const row = {
      id: 'f1', tenantId: TENANT, name: 'Васил', role: 'Ягодоплодни',
      commissionRateBps: 500, subscriptionFeeStotinki: 1200,
    };
    db.queue([row]);

    const svc = new FarmersService(db as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const out = await svc.findAll(TENANT);

    expect(out).toEqual([row]);
    expect(out[0]).toHaveProperty('commissionRateBps', 500);
    expect(out[0]).toHaveProperty('subscriptionFeeStotinki', 1200);
  });
});
