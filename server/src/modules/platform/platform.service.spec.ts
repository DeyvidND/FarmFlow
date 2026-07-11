import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth/auth.service';
import { BillingService } from '../billing/billing.service';
import { PlatformService } from './platform.service';
import { ProductsService } from '../products/products.service';
import { FarmersService } from '../farmers/farmers.service';
import { SubcategoriesService } from '../subcategories/subcategories.service';
import { TenantsService } from '../tenants/tenants.service';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { ConfigService } from '@nestjs/config';
import { auditLogs, users, orderItems, orders, products, emailPushes, newsletterCampaigns, shipments } from '@fermeribg/db';
import { withEcontActive } from '../econt-app/econt-app.helpers';

// Mock argon2 at module level so native bindings are not called.
jest.mock('argon2', () => ({
  verify: jest.fn(),
  hash: jest.fn(),
}));
import * as argon2 from 'argon2';

// ─── Mock DB builder ──────────────────────────────────────────────────────────
function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockReturnThis(),
    transaction: jest.fn(),
  };
}

const ADMIN_ID = 'admin-uuid-1';

describe('PlatformService', () => {
  let service: PlatformService;
  let db: ReturnType<typeof makeDb>;
  let cacheDel: jest.Mock;
  let issueInvite: jest.Mock;

  const productsCreate = jest.fn().mockResolvedValue({ id: 'p' });
  const farmersCreate = jest.fn().mockResolvedValue({ id: 'f' });
  const subcategoriesCreate = jest.fn().mockResolvedValue({ id: 'c' });
  const storageDeleteByPrefix = jest.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    db = makeDb();
    cacheDel = jest.fn().mockResolvedValue(undefined);
    issueInvite = jest.fn().mockResolvedValue({ link: 'https://dostavki.fermeribg.com/reset-password?token=tok' });
    jest.clearAllMocks();
    productsCreate.mockClear().mockResolvedValue({ id: 'p' });
    farmersCreate.mockClear().mockResolvedValue({ id: 'f' });
    subcategoriesCreate.mockClear().mockResolvedValue({ id: 'c' });
    storageDeleteByPrefix.mockClear().mockResolvedValue(undefined);
    issueInvite.mockClear().mockResolvedValue({ link: 'https://dostavki.fermeribg.com/reset-password?token=tok' });
    db.where.mockReturnValue(db); // chainable for delete().where()
    db.transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => cb(db));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformService,
        { provide: DB_TOKEN, useValue: db },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('platform-token') },
        },
        { provide: AuthService, useValue: { issueInvite } },
        { provide: BillingService, useValue: { setPremium: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: PublicCacheService,
          useValue: {
            del: cacheDel,
            // listTenants now checks the cache first; return a miss so tests
            // continue to exercise the live DB path.
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ConfigService, useValue: { get: (_k: string, d?: any) => (_k === 'EMAIL_COST_PER_RECIPIENT_MICRO' ? 370 : d) } },
        { provide: ProductsService, useValue: { create: productsCreate } },
        { provide: FarmersService, useValue: { create: farmersCreate } },
        { provide: SubcategoriesService, useValue: { create: subcategoriesCreate } },
        { provide: TenantsService, useValue: { updateSiteContact: jest.fn(), setFavicon: jest.fn() } },
        { provide: StorageService, useValue: { deleteByPrefix: storageDeleteByPrefix } },
        { provide: CatalogCacheService, useValue: { invalidate: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get(PlatformService);
  });

  // ── emailBilling (revenue / cost / margin) ──────────────────────────────────
  describe('emailBilling', () => {
    it('computes Resend cost + margin per farm and platform totals', async () => {
      db.orderBy.mockResolvedValueOnce([
        { tenantId: 't1', name: 'Ферма А', slug: 'a', email: null, pushCount: 2, recipientTotal: 1000, totalStotinki: 56, lastPushAt: null },
        { tenantId: 't2', name: 'Ферма Б', slug: 'b', email: null, pushCount: 1, recipientTotal: 200, totalStotinki: 11, lastPushAt: null },
      ]);

      const { rows, totals } = await service.emailBilling();

      // cost = round(recipients × 370 / 10000): 1000 → 37, 200 → 7
      expect(rows[0].costStotinki).toBe(37);
      expect(rows[0].marginStotinki).toBe(56 - 37);
      expect(rows[1].costStotinki).toBe(7);
      expect(totals.recipientTotal).toBe(1200);
      expect(totals.revenueStotinki).toBe(67);
      expect(totals.costStotinki).toBe(44);
      expect(totals.marginStotinki).toBe(23);
    });
  });

  // ── createTenant ──────────────────────────────────────────────────────────

  describe('createTenant', () => {
    const dto = {
      farmName: 'Ферма Петрови',
      email: 'ivan@farm.bg',
      tempPassword: 'secret123',
    };

    it('creates a tenant and owner user with mustChangePassword=true, returns summary', async () => {
      // No duplicate email
      db.limit.mockResolvedValueOnce([]);
      // No slug collision
      db.limit.mockResolvedValueOnce([]);
      // Tenant insert
      const tenantRow = { id: 'tenant-1', name: dto.farmName, slug: 'ferma-petrovi', email: dto.email };
      db.returning.mockResolvedValueOnce([tenantRow]);
      // argon2.hash
      (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed-pass');
      // User insert
      db.returning.mockResolvedValueOnce([
        { id: 'user-1', email: dto.email, mustChangePassword: true },
      ]);

      const result = await service.createTenant(dto);

      expect(result).toMatchObject({
        id: 'tenant-1',
        name: dto.farmName,
        slug: expect.any(String),
        email: dto.email,
      });

      // The user insert must include mustChangePassword: true
      // values() is called once for tenant, once for user; user call is index 1
      const userValuesCall = db.values.mock.calls[1]?.[0];
      expect(userValuesCall).toMatchObject({ mustChangePassword: true });
    });

    it('throws ConflictException when email already exists', async () => {
      db.limit.mockResolvedValueOnce([{ id: 'existing' }]);

      await expect(service.createTenant(dto)).rejects.toThrow(ConflictException);
    });
  });

  // ── createDemoTenant ────────────────────────────────────────────────────────
  describe('createDemoTenant', () => {
    it('creates an is_demo tenant with a future expiry, owner mustChangePassword=false, and seeds the demo catalog', async () => {
      db.limit.mockResolvedValueOnce([]);           // email free
      db.limit.mockResolvedValueOnce([]);           // slug free
      const tenantRow = { id: 'demo-1', name: 'Демо ферма ab12', slug: 'demo-ferma-ab12', email: 'demo-x@demo.fermeribg.bg' };
      db.returning.mockResolvedValueOnce([tenantRow]);  // tenant insert
      (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed');
      db.returning.mockResolvedValueOnce([{ id: 'user-1' }]); // user insert
      db.limit.mockResolvedValueOnce([{ id: 'demo-1' }]);     // importTenant tenant-exists

      const before = Date.now();
      const res = await service.createDemoTenant(14);

      const tenantValues = db.values.mock.calls[0]?.[0];
      expect(tenantValues).toMatchObject({ isDemo: true });
      expect(tenantValues.demoExpiresAt.getTime()).toBeGreaterThan(before);

      const userValues = db.values.mock.calls[1]?.[0];
      expect(userValues).toMatchObject({ role: 'admin', mustChangePassword: false });

      expect(subcategoriesCreate).toHaveBeenCalledTimes(3);
      expect(farmersCreate).toHaveBeenCalledTimes(2);
      expect(productsCreate).toHaveBeenCalledTimes(8);

      expect(res).toMatchObject({ id: 'demo-1', email: expect.stringContaining('@'), password: expect.any(String) });
      expect(typeof res.expiresAt).toBe('string');
      expect(res.password.length).toBeGreaterThanOrEqual(12);
    });
  });

  // ── updateTenant (siteUrl) ───────────────────────────────────────────────

  describe('updateTenant — siteUrl', () => {
    const TENANT_ID = 'tenant-uuid-1';
    const existing = { id: TENANT_ID, slug: 'ferma-test' };

    function setupExisting() {
      // First select returns the existing tenant row
      db.limit.mockResolvedValueOnce([existing]);
    }

    /** Walk a drizzle SQL queryChunks tree and collect all string-like leaf values. */
    function flatChunks(chunks: any[]): string {
      return chunks.map((c: any) => {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return flatChunks(c);
        // StringChunk: { value: string[] }; Param: { value: unknown }; SQL: { queryChunks: [] }
        if (Array.isArray(c?.value)) return c.value.join('');
        if (c?.queryChunks) return flatChunks(c.queryChunks);
        if (c?.value !== undefined) return String(c.value);
        return '';
      }).join('');
    }

    it('writes sanitized siteUrl into settings.siteUrl (trailing slash stripped) and busts cache', async () => {
      setupExisting();

      // Capture the set() call to inspect the drizzle sql template
      let capturedSet: any;
      db.set.mockImplementationOnce((val: any) => { capturedSet = val; return db; });

      await service.updateTenant(TENANT_ID, { siteUrl: 'https://x.test/' });

      // settings must be a drizzle SQL expression containing the sanitized URL
      expect(capturedSet?.settings?.queryChunks).toBeDefined();
      const text = flatChunks(capturedSet.settings.queryChunks);
      // sanitizeSiteUrl('https://x.test/') === 'https://x.test' (trailing slash stripped)
      expect(text).toContain('https://x.test');
      // The sanitized value must NOT retain the trailing slash
      expect(text).not.toContain('https://x.test/');
      // cache must be busted with the slug key
      expect(cacheDel).toHaveBeenCalledWith('tenant:ferma-test');
    });

    it('writes empty string for a non-http(s) siteUrl (javascript:1 → sanitized to "")', async () => {
      setupExisting();

      let capturedSet: any;
      db.set.mockImplementationOnce((val: any) => { capturedSet = val; return db; });

      await service.updateTenant(TENANT_ID, { siteUrl: 'javascript:1' });

      expect(capturedSet?.settings?.queryChunks).toBeDefined();
      const text = flatChunks(capturedSet.settings.queryChunks);
      // sanitizeSiteUrl('javascript:1') === '' → JSON.stringify('') = '""'
      expect(text).toContain('""');
      // must not contain 'javascript'
      expect(text).not.toContain('javascript');
    });

    it('persists the deliveriesPackageEnabled flag in the column patch', async () => {
      setupExisting();

      let capturedSet: any;
      db.set.mockImplementationOnce((val: any) => { capturedSet = val; return db; });

      await service.updateTenant(TENANT_ID, { deliveriesPackageEnabled: false });

      expect(capturedSet?.deliveriesPackageEnabled).toBe(false);
      // The flag changes the cached storefront methods/econtEnabled, so the
      // tenant:slug profile cache must be busted (among the farmers/subcats keys).
      expect(cacheDel.mock.calls.flat()).toContain('tenant:ferma-test');
    });
  });

  // ── tenantDetail ─────────────────────────────────────────────────────────

  describe('tenantDetail', () => {
    const TENANT_ID = 'tenant-detail-uuid';

    function makeTenantRow(overrides: Record<string, any> = {}) {
      return {
        id: TENANT_ID,
        name: 'Ферма Тест',
        slug: 'ferma-test',
        email: 'test@farm.bg',
        phone: null,
        subscriptionStatus: 'active',
        premium: false,
        graceUntil: null,
        createdAt: new Date('2024-01-01'),
        deliveryEnabled: false,
        deliveriesPackageEnabled: true,
        multiFarmer: false,
        multiSubcat: false,
        stripeAccountId: null,
        settings: {},
        ...overrides,
      };
    }

    /** Set up DB mock chain for tenantDetail.
     *
     * Call sequence in tenantDetail:
     *  1. select().from(tenants).where().limit(1)           → [tenantRow]
     *  2-6. oP/pP/sP/rP/eP: select().from().where()        → each must resolve to [{...}]
     *  7. recentOrdersP: select().from().where().orderBy().limit(8) → []
     *
     * The default `where` mock returns `db` (chainable but not iterable). For calls 2-6 we
     * need `await where()` to yield an array so `[[o],[p],...] = await Promise.all(...)` works.
     * We override `where` with a sequence: call 1 → db (limit() continues chain), calls 2-6 →
     * Promise.resolve([{}]) (aggregate placeholders), call 7 → db (orderBy().limit() continues).
     */
    function setupChain(tenantRow: ReturnType<typeof makeTenantRow>) {
      const emptyAgg = Promise.resolve([{}]);
      db.where
        .mockReturnValueOnce(db)            // call 1: tenant lookup → chain to limit()
        .mockReturnValueOnce(emptyAgg)      // call 2: oP aggregate
        .mockReturnValueOnce(emptyAgg)      // call 3: pP aggregate
        .mockReturnValueOnce(emptyAgg)      // call 4: sP aggregate
        .mockReturnValueOnce(emptyAgg)      // call 5: rP aggregate
        .mockReturnValueOnce(emptyAgg)      // call 6: eP aggregate
        .mockReturnValueOnce(db);           // call 7: recentOrdersP → chain to orderBy().limit()
      // 1st limit() call = tenant row lookup
      db.limit.mockResolvedValueOnce([tenantRow]);
      // recentOrdersP ends with .orderBy().limit(8); orderBy must return db so limit() is reachable
      db.orderBy.mockReturnValueOnce(db);
      // 2nd limit() call = recentOrdersP resolves to []
      db.limit.mockResolvedValueOnce([]);
      // Per-farmer aggregates added after recentOrders (calls 8-11):
      //  8. farmersBaseP: …leftJoin().where()→orderBy() — where #8 falls through to the
      //     default db, orderBy #2 falls through to the default [] → no farmers.
      //  9-11. prod/order/ship per-farmer aggregates end in .groupBy() → resolve to [].
      db.groupBy.mockResolvedValue([]);
    }

    it('returns siteUrl from settings.siteUrl (sanitized — trailing slash stripped)', async () => {
      setupChain(makeTenantRow({ settings: { siteUrl: 'https://mysite.bg/' } }));

      const result = await service.tenantDetail(TENANT_ID);

      expect(result.siteUrl).toBe('https://mysite.bg');
    });

    it('returns empty string when settings.siteUrl is absent', async () => {
      setupChain(makeTenantRow({ settings: {} }));

      const result = await service.tenantDetail(TENANT_ID);

      expect(result.siteUrl).toBe('');
    });

    it('returns empty string when settings.siteUrl is a non-http(s) value', async () => {
      setupChain(makeTenantRow({ settings: { siteUrl: 'javascript:alert(1)' } }));

      const result = await service.tenantDetail(TENANT_ID);

      expect(result.siteUrl).toBe('');
    });

    it('builds a per-farmer breakdown: login, carriers and merged counts', async () => {
      const tenantRow = makeTenantRow({
        settings: {
          delivery: { farmers: { 'farmer-1': { econt: { configured: true }, speedy: { configured: false } } } },
        },
      });
      // where: #1 tenant→db, #2-6 aggregates→[{}], #7-11 →db (recentOrders + 4 farmer queries)
      db.where
        .mockReturnValueOnce(db)
        .mockReturnValueOnce(Promise.resolve([{}]))
        .mockReturnValueOnce(Promise.resolve([{}]))
        .mockReturnValueOnce(Promise.resolve([{}]))
        .mockReturnValueOnce(Promise.resolve([{}]))
        .mockReturnValueOnce(Promise.resolve([{}]))
        .mockReturnValue(db);
      db.limit
        .mockResolvedValueOnce([tenantRow]) // tenant lookup
        .mockResolvedValueOnce([]);         // recentOrders
      db.orderBy
        .mockReturnValueOnce(db)            // recentOrders → limit
        .mockResolvedValueOnce([           // farmersBaseP terminal
          { id: 'farmer-1', name: 'Иван', role: 'Пчелар', userId: 'u1', loginEmail: 'ivan@farm.bg', mustChange: false },
        ]);
      db.groupBy
        .mockResolvedValueOnce([{ farmerId: 'farmer-1', n: 5 }])                                       // products
        .mockResolvedValueOnce([{ farmerId: 'farmer-1', n: 3, revenueStotinki: 4200 }])               // courier orders
        .mockResolvedValueOnce([{ farmerId: 'farmer-1', total: 2, drafts: 1, codPendingStotinki: 1500 }]); // shipments

      const result = await service.tenantDetail(TENANT_ID);

      expect(result.farmers).toHaveLength(1);
      expect(result.farmers[0]).toMatchObject({
        id: 'farmer-1',
        name: 'Иван',
        hasLogin: true,
        loginEmail: 'ivan@farm.bg',
        invitePending: false,
        econtConnected: true,
        speedyConnected: false,
        products: 5,
        courierOrders: 3,
        courierRevenueStotinki: 4200,
        shipments: 2,
        draftShipments: 1,
        codPendingStotinki: 1500,
      });
    });
  });

  // ── farmerDetail ────────────────────────────────────────────────────────────
  describe('farmerDetail', () => {
    it('404s when the farmer is missing', async () => {
      db.limit.mockResolvedValueOnce([]); // base lookup → none
      await expect(service.farmerDetail('missing-uuid')).rejects.toThrow(NotFoundException);
    });

    it('merges base, counts, COD and recent rows', async () => {
      const base = {
        id: 'f1',
        name: 'Иван',
        role: 'Пчелар',
        tenantId: 't1',
        tenantName: 'Ферма',
        tenantSlug: 'ferma',
        settings: { delivery: { farmers: { f1: { econt: { configured: true }, speedy: { configured: false } } } } },
        userId: 'u1',
        loginEmail: 'ivan@farm.bg',
        mustChange: false,
      };
      db.where
        .mockReturnValueOnce(db) // base → limit
        .mockResolvedValueOnce([{ n: 5 }]) // products
        .mockResolvedValueOnce([{ n: 3 }]) // courier orders
        .mockResolvedValueOnce([{ total: 2, drafts: 1, pendingStotinki: 1500, collectedStotinki: 0 }]) // ship agg
        .mockReturnValue(db); // recentShip + recentOrd where → db
      db.orderBy.mockReturnValue(db); // recentShip/recentOrd orderBy → db (chain to limit)
      db.limit
        .mockResolvedValueOnce([base]) // base lookup
        .mockResolvedValueOnce([
          { id: 's1', receiverName: 'Петър', carrier: 'econt', status: 'created', codAmountStotinki: 1500, trackingNumber: 'BG1', createdAt: new Date('2024-03-01') },
        ]) // recent shipments
        .mockResolvedValueOnce([
          { id: 'o1', customerName: 'Петър', totalStotinki: 2000, status: 'confirmed', createdAt: new Date('2024-03-01') },
        ]); // recent orders

      const result = await service.farmerDetail('f1');

      expect(result).toMatchObject({
        id: 'f1',
        name: 'Иван',
        tenantName: 'Ферма',
        hasLogin: true,
        loginEmail: 'ivan@farm.bg',
        econtConnected: true,
        speedyConnected: false,
        counts: { products: 5, courierOrders: 3, shipments: 2, draftShipments: 1 },
        cod: { pendingStotinki: 1500, collectedStotinki: 0 },
      });
      expect(result.recentShipments).toHaveLength(1);
      expect(result.recentOrders).toHaveLength(1);
    });
  });

  // ── listAllFarmers ──────────────────────────────────────────────────────────
  describe('listAllFarmers', () => {
    it('returns a cross-tenant farmer row with merged counts + carriers', async () => {
      const farmerRow = {
        id: 'f1',
        name: 'Иван',
        role: 'Пчелар',
        createdAt: new Date('2024-02-01'),
        tenantId: 't1',
        tenantName: 'Ферма Тест',
        tenantSlug: 'ferma-test',
        isDemo: false,
        settings: { delivery: { farmers: { f1: { econt: { configured: true }, speedy: { configured: false } } } } },
        userId: 'u1',
        loginEmail: 'ivan@farm.bg',
        mustChange: false,
      };
      // base query: …innerJoin().leftJoin().orderBy().limit() — orderBy returns db, limit = rows.
      db.orderBy.mockReturnValueOnce(db);
      db.limit.mockResolvedValueOnce([farmerRow]);
      // 3 per-page count queries each end in .groupBy().
      db.groupBy
        .mockResolvedValueOnce([{ farmerId: 'f1', n: 7 }])                                          // products
        .mockResolvedValueOnce([{ farmerId: 'f1', n: 4 }])                                          // courier orders
        .mockResolvedValueOnce([{ farmerId: 'f1', total: 3, drafts: 1, codPendingStotinki: 2500 }]); // shipments

      const result = await service.listAllFarmers({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'f1',
        name: 'Иван',
        tenantName: 'Ферма Тест',
        isDemo: false,
        hasLogin: true,
        loginEmail: 'ivan@farm.bg',
        invitePending: false,
        econtConnected: true,
        speedyConnected: false,
        products: 7,
        courierOrders: 4,
        shipments: 3,
        draftShipments: 1,
        codPendingStotinki: 2500,
      });
    });
  });

  // ── deleteTenant ────────────────────────────────────────────────────────────
  describe('deleteTenant', () => {
    it('refuses to hard-delete a non-demo tenant without a matching slug', async () => {
      db.limit.mockResolvedValueOnce([{ id: 't1', slug: 'real-farm', isDemo: false }]);
      await expect(service.deleteTenant('t1')).rejects.toThrow(/slug/i);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(storageDeleteByPrefix).not.toHaveBeenCalled();
    });

    it('refuses to hard-delete a non-demo tenant when the slug does not match exactly', async () => {
      db.limit.mockResolvedValueOnce([{ id: 't1', slug: 'real-farm', isDemo: false }]);
      await expect(service.deleteTenant('t1', 'real-far')).rejects.toThrow(/slug/i);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('hard-deletes a non-demo tenant when the confirm slug matches exactly', async () => {
      db.limit.mockResolvedValueOnce([{ id: 't1', slug: 'real-farm', isDemo: false }]);
      await service.deleteTenant('t1', 'real-farm');
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(storageDeleteByPrefix).toHaveBeenCalledWith('tenants/real-farm/');
    });

    it('throws NotFound when the tenant does not exist', async () => {
      db.limit.mockResolvedValueOnce([]);
      await expect(service.deleteTenant('missing')).rejects.toThrow(NotFoundException);
    });

    it('hard-deletes a demo tenant in a transaction and sweeps its R2 prefix', async () => {
      db.limit.mockResolvedValueOnce([{ id: 'demo-1', slug: 'demo-ferma-ab12', isDemo: true }]);
      await service.deleteTenant('demo-1');
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(db.delete.mock.calls.length).toBeGreaterThanOrEqual(15);
      expect(storageDeleteByPrefix).toHaveBeenCalledWith('tenants/demo-ferma-ab12/');

      // Assert FK-safe delete ordering — the property this test exists to enforce.
      const deleteOrder = db.delete.mock.calls.map((c) => c[0]);
      const idx = (tbl: unknown) => deleteOrder.indexOf(tbl);
      // audit_logs.user_id → users is NO ACTION: audit rows must go before users.
      expect(idx(auditLogs)).toBeGreaterThanOrEqual(0);
      expect(idx(auditLogs)).toBeLessThan(idx(users));
      // other NO ACTION FK precedences that must hold:
      expect(idx(orderItems)).toBeLessThan(idx(orders));
      expect(idx(orderItems)).toBeLessThan(idx(products));
      expect(idx(shipments)).toBeLessThan(idx(orders));
      expect(idx(emailPushes)).toBeLessThan(idx(newsletterCampaigns));
    });
  });

  // ── resetOwnerPassword ──────────────────────────────────────────────────────
  describe('resetOwnerPassword', () => {
    it('mints a temp password, forces a change, bumps tokenVersion, and returns the plaintext once', async () => {
      db.limit.mockResolvedValueOnce([{ id: 't1', name: 'Ферма А', email: 'a@farm.bg' }]); // tenant lookup
      (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed-temp');
      db.returning.mockResolvedValueOnce([{ id: 'owner-1' }]); // user update

      let capturedSet: any;
      db.set.mockImplementationOnce((val: any) => { capturedSet = val; return db; });

      const res = await service.resetOwnerPassword('t1');

      expect(capturedSet).toMatchObject({ passwordHash: 'hashed-temp', mustChangePassword: true });
      expect(capturedSet.tokenVersion).toBeDefined(); // sql`tokenVersion + 1`
      expect(res).toMatchObject({ id: 't1', name: 'Ферма А', email: 'a@farm.bg' });
      expect(res.tempPassword.length).toBeGreaterThanOrEqual(12);
    });

    it('throws NotFound when the tenant does not exist', async () => {
      db.limit.mockResolvedValueOnce([]);
      await expect(service.resetOwnerPassword('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFound when the farm has no owner user', async () => {
      db.limit.mockResolvedValueOnce([{ id: 't1', name: 'Ферма А', email: 'a@farm.bg' }]);
      (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed-temp');
      db.returning.mockResolvedValueOnce([]); // no admin user updated
      await expect(service.resetOwnerPassword('t1')).rejects.toThrow(NotFoundException);
    });
  });

  // ── deleteExpiredDemos ──────────────────────────────────────────────────────
  describe('deleteExpiredDemos', () => {
    it('deletes each expired demo and returns the count', async () => {
      // initial select of expired demo ids
      db.where.mockReturnValueOnce(Promise.resolve([{ id: 'd1' }, { id: 'd2' }]) as any);
      const spy = jest.spyOn(service, 'deleteTenant').mockResolvedValue({ id: 'x' });

      const res = await service.deleteExpiredDemos();

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith('d1');
      expect(spy).toHaveBeenCalledWith('d2');
      expect(res).toEqual({ deleted: 2 });
      spy.mockRestore();
    });

    it('continues past a failing tenant and counts only successful deletes', async () => {
      db.where.mockReturnValueOnce(Promise.resolve([{ id: 'd1' }, { id: 'd2' }]) as any);
      const spy = jest
        .spyOn(service, 'deleteTenant')
        .mockRejectedValueOnce(new Error('boom')) // d1 fails
        .mockResolvedValueOnce({ id: 'd2' });      // d2 succeeds

      const res = await service.deleteExpiredDemos();

      expect(spy).toHaveBeenCalledTimes(2);        // both attempted despite d1 failing
      expect(spy).toHaveBeenCalledWith('d1');
      expect(spy).toHaveBeenCalledWith('d2');
      expect(res).toEqual({ deleted: 1 });         // only the successful one counted
      spy.mockRestore();
    });
  });

  // ── listTenants (demo fields) ───────────────────────────────────────────────
  describe('listTenants', () => {
    it('selects isDemo and demoExpiresAt for each row', async () => {
      // listTenants chain: .select().from().leftJoin() → .groupBy().orderBy().limit(lim+1)
      // orderBy must be chainable (returns this); limit is the terminal awaited call.
      db.orderBy.mockReturnValueOnce(db);
      db.limit.mockResolvedValueOnce([
        { id: 't1', name: 'A', slug: 'a', email: null, phone: null, subscriptionStatus: 'active', premium: false, graceUntil: null, createdAt: new Date('2024-01-01'), orderCount: 0, lastOrderAt: null, isDemo: true, demoExpiresAt: new Date('2099-01-01') },
      ]);
      const page = await service.listTenants({});
      expect(page.items[0]).toMatchObject({ isDemo: true });
      expect(page.items[0].demoExpiresAt).toBeInstanceOf(Date);
    });
  });

  // ── platformChangePassword ────────────────────────────────────────────────

  describe('platformChangePassword', () => {
    const adminRow = { id: ADMIN_ID, passwordHash: '$argon2id$fake' };

    it('throws UnauthorizedException when current password is wrong', async () => {
      db.limit.mockResolvedValueOnce([adminRow]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(false);

      await expect(
        service.platformChangePassword(ADMIN_ID, { currentPassword: 'wrong', newPassword: 'new123' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('returns a fresh token (revoking old sessions) when current password is correct', async () => {
      db.limit.mockResolvedValueOnce([adminRow]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
      (argon2.hash as jest.Mock).mockResolvedValueOnce('new-hash');
      db.returning.mockResolvedValueOnce([{ id: ADMIN_ID, tokenVersion: 1 }]);

      const result = await service.platformChangePassword(ADMIN_ID, {
        currentPassword: 'correct',
        newPassword: 'newPass1',
      });

      expect(result).toEqual({ accessToken: 'platform-token' });
      // mustChangePassword must be cleared + tokenVersion bumped on the update.
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({ passwordHash: 'new-hash', mustChangePassword: false }),
      );
    });
  });

  // ── Delivery accounts ───────────────────────────────────────────────────────
  describe('listDeliveryAccounts', () => {
    it('returns delivery-capable tenants with a folded shipment overview', async () => {
      db.where.mockReturnValueOnce(db); // tenant query .where → chains to orderBy
      db.orderBy.mockReturnValueOnce(db); // → chains to limit
      db.limit.mockResolvedValueOnce([
        {
          id: 't1', name: 'Дел Едно', slug: 'del-edno', email: 'a@x.bg', phone: null,
          settings: { product: 'econt-standalone', econtApp: { active: true } }, createdAt: new Date('2026-06-01'),
        },
      ]);
      db.where.mockResolvedValueOnce([
        { tenantId: 't1', carrier: 'econt', codAmountStotinki: 1000, codCollectedAt: null, createdAt: new Date('2026-06-02') },
        { tenantId: 't1', carrier: 'speedy', codAmountStotinki: 500, codCollectedAt: new Date('2026-06-04'), createdAt: new Date('2026-06-03') },
      ]);

      const res = await service.listDeliveryAccounts({});
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({ id: 't1', type: 'delivery', active: true });
      expect(res.items[0].overview).toEqual({
        total: 2, codPendingStotinki: 1000, codCollectedStotinki: 500, econt: 1, speedy: 1,
        lastShipmentAt: '2026-06-03T00:00:00.000Z',
      });
    });
  });

  describe('getDeliveryAccount', () => {
    it('404s when the tenant is not delivery-capable', async () => {
      db.where.mockReturnValueOnce(db);
      db.limit.mockResolvedValueOnce([
        { id: 't9', name: 'Ферма', slug: 'ferma', email: null, phone: null, settings: { delivery: {} }, createdAt: new Date() },
      ]);
      await expect(service.getDeliveryAccount('t9')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns overview + recent shipments for a delivery account', async () => {
      db.where.mockReturnValueOnce(db);
      db.limit.mockResolvedValueOnce([
        { id: 't1', name: 'Дел', slug: 'del', email: null, phone: null, settings: { econtApp: { active: true } }, createdAt: new Date('2026-06-01') },
      ]);
      db.where.mockResolvedValueOnce([
        { id: 's1', carrier: 'econt', status: 'created', codAmountStotinki: 1000, codCollectedAt: null, createdAt: new Date('2026-06-02'), trackingNumber: null, econtShipmentNumber: 'E1' },
      ]);
      const res = await service.getDeliveryAccount('t1');
      expect(res.type).toBe('both');
      expect(res.overview.total).toBe(1);
      expect(res.recentShipments).toHaveLength(1);
    });
  });

  // ── listDeliveryShipments (full paginated history) ──────────────────────────
  describe('listDeliveryShipments', () => {
    it('404s when the tenant is not delivery-capable', async () => {
      // tenant lookup → a non-delivery settings blob
      db.limit.mockResolvedValueOnce([{ id: 't9', settings: { delivery: {} } }]);
      await expect(service.listDeliveryShipments('t9')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a first page with nextCursor, then advances on the cursor', async () => {
      const mk = (i: number) => ({
        id: `s${i}`,
        receiverName: `Получател ${i}`,
        carrier: 'econt',
        status: 'created',
        codAmountStotinki: 1000,
        codCollectedAt: null,
        codSettledAt: null,
        createdAt: new Date(`2026-06-${String(20 - i).padStart(2, '0')}`),
        trackingNumber: null,
        econtShipmentNumber: `E${i}`,
        // Micro-precision cursor column the query projects (see cursorTs); the
        // service reads it to build nextCursor and strips it from the items.
        __keysetTs: `2026-06-${String(20 - i).padStart(2, '0')}T00:00:00.000000`,
      });

      // ── Page 1 (limit 2): tenant lookup → delivery-capable; query returns lim+1=3 rows ──
      db.limit.mockResolvedValueOnce([{ id: 't1', settings: { econtApp: { active: true } } }]); // tenant lookup
      db.orderBy.mockReturnValueOnce(db); // shipments query → chain to limit
      db.limit.mockResolvedValueOnce([mk(1), mk(2), mk(3)]); // 3 rows → hasMore

      const page1 = await service.listDeliveryShipments('t1', { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.items[0].receiverName).toBe('Получател 1');
      expect(page1.nextCursor).not.toBeNull();

      // ── Page 2: pass the cursor; only 1 row remains → no more pages ──
      db.limit.mockResolvedValueOnce([{ id: 't1', settings: { econtApp: { active: true } } }]); // tenant lookup
      db.orderBy.mockReturnValueOnce(db);
      db.limit.mockResolvedValueOnce([mk(3)]); // 1 row → end

      const page2 = await service.listDeliveryShipments('t1', { limit: 2, cursor: page1.nextCursor! });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).toBe('s3');
      expect(page2.nextCursor).toBeNull();
    });
  });

  describe('createDeliveryAccount', () => {
    beforeEach(() => {
      (argon2.hash as jest.Mock).mockResolvedValue('hashed');
      db.limit.mockResolvedValue([]); // no email clash, slug free
      // The txn calls .returning() twice: tenant row (full), then user row ({ id }).
      db.returning
        .mockResolvedValueOnce([{ id: 'new1', name: 'Нов', slug: 'nov', email: 'n@x.bg' }])
        .mockResolvedValueOnce([{ id: 'user-new1' }]);
    });

    it('rejects when neither role is selected', async () => {
      await expect(
        service.createDeliveryAccount({ email: 'a@x.bg', name: 'X', shop: false, delivery: false }),
      ).rejects.toMatchObject({ message: 'Изберете поне една роля' });
    });

    it('rejects a duplicate email', async () => {
      db.limit.mockResolvedValueOnce([{ id: 'u' }]);
      await expect(
        service.createDeliveryAccount({ email: 'a@x.bg', name: 'X', shop: true, delivery: false }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates a delivery-only account with econt-standalone settings', async () => {
      await service.createDeliveryAccount({ email: 'd@x.bg', name: 'Дел', shop: false, delivery: true, active: true });
      const v = db.values.mock.calls[0][0];
      expect(v.settings.product).toBe('econt-standalone');
      expect(v.settings.econtApp).toEqual({ active: true });
      expect(v.deliveryEnabled).toBe(false);
    });

    it('creates a both account: farm settings + econtApp', async () => {
      await service.createDeliveryAccount({ email: 'b@x.bg', name: 'Двете', shop: true, delivery: true, active: false });
      const v = db.values.mock.calls[0][0];
      expect(v.settings.product).toBeUndefined();
      expect(v.settings.delivery).toBeDefined();
      expect(v.settings.econtApp).toEqual({ active: false });
      expect(v.deliveryEnabled).toBe(true);
    });

    it('marks the tenant isDemo when demo=true (carriers run on demo env)', async () => {
      await service.createDeliveryAccount({ email: 'demo@x.bg', name: 'Демо', shop: false, delivery: true, demo: true });
      const v = db.values.mock.calls[0][0];
      expect(v.isDemo).toBe(true);
    });

    it('defaults isDemo=false for a real account', async () => {
      await service.createDeliveryAccount({ email: 'real@x.bg', name: 'Реал', shop: false, delivery: true });
      const v = db.values.mock.calls[0][0];
      expect(v.isDemo).toBe(false);
    });

    it('creates a password-less admin user (mustChangePassword=true) — no password set', async () => {
      await service.createDeliveryAccount({ email: 's@x.bg', name: 'Само', shop: true, delivery: false });
      // values() call 1 = tenant, call 2 = user
      const userValues = db.values.mock.calls[1][0];
      expect(userValues).toMatchObject({ role: 'admin', mustChangePassword: true });
    });

    it('mints + emails an invite link and returns it (no password in the result)', async () => {
      const res = await service.createDeliveryAccount({ email: 's@x.bg', name: 'Само', shop: true, delivery: false });
      // issueInvite called for the created user, targeting the delivery app, with email on.
      expect(issueInvite).toHaveBeenCalledWith('user-new1', expect.objectContaining({ email: true }));
      expect(issueInvite.mock.calls[0][1].appUrl).toContain('dostavki');
      expect(res).toMatchObject({ id: 'new1', email: 'n@x.bg', inviteLink: expect.stringContaining('reset-password') });
      expect((res as Record<string, unknown>).password).toBeUndefined();
    });
  });

  // ── resendDeliveryInvite ────────────────────────────────────────────────────
  describe('resendDeliveryInvite', () => {
    it('404s when the tenant is not delivery-capable', async () => {
      // tenant lookup → non-delivery settings (no econtApp)
      db.limit.mockResolvedValueOnce([{ id: 't9', settings: { delivery: {} } }]);
      await expect(service.resendDeliveryInvite('t9')).rejects.toBeInstanceOf(NotFoundException);
      expect(issueInvite).not.toHaveBeenCalled();
    });

    it('404s when the delivery account has no admin user', async () => {
      db.limit.mockResolvedValueOnce([{ id: 't1', settings: { econtApp: { active: true } } }]); // delivery-capable
      db.limit.mockResolvedValueOnce([]); // no admin user
      await expect(service.resendDeliveryInvite('t1')).rejects.toBeInstanceOf(NotFoundException);
      expect(issueInvite).not.toHaveBeenCalled();
    });

    it('re-mints + emails the invite and returns the fresh link', async () => {
      db.limit.mockResolvedValueOnce([{ id: 't1', settings: { econtApp: { active: true } } }]); // delivery-capable
      db.limit.mockResolvedValueOnce([{ id: 'admin-1' }]); // admin user
      const res = await service.resendDeliveryInvite('t1');
      expect(issueInvite).toHaveBeenCalledWith('admin-1', expect.objectContaining({ email: true }));
      expect(res).toEqual({ inviteLink: expect.stringContaining('reset-password') });
    });
  });

  describe('enableDeliveryOnFarm', () => {
    it('404s for a missing tenant', async () => {
      db.limit.mockResolvedValueOnce([]);
      await expect(service.enableDeliveryOnFarm('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('merges econtApp into an existing farm additively', async () => {
      db.limit.mockResolvedValueOnce([{ id: 'f1', settings: { delivery: { cod: { enabled: true } } } }]);
      const res = await service.enableDeliveryOnFarm('f1');
      expect(res).toEqual({ id: 'f1', delivery: true });
      const written = db.set.mock.calls[0][0].settings;
      expect(written.delivery).toEqual({ cod: { enabled: true } });
      expect(written.econtApp).toEqual({ active: true });
    });

    it('is idempotent when delivery is already enabled (no write)', async () => {
      db.limit.mockResolvedValueOnce([{ id: 'f2', settings: { econtApp: { active: false } } }]);
      const res = await service.enableDeliveryOnFarm('f2');
      expect(res).toEqual({ id: 'f2', delivery: true });
      expect(db.set).not.toHaveBeenCalled();
    });
  });
});

describe('withEcontActive (used by platform activate)', () => {
  it('activates without dropping other settings', () => {
    expect(withEcontActive({ product: 'econt-standalone', delivery: { x: 1 } }, true)).toEqual({
      product: 'econt-standalone',
      delivery: { x: 1 },
      econtApp: { active: true },
    });
  });
});
