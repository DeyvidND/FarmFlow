import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BillingService } from '../billing/billing.service';
import { PlatformService } from './platform.service';
import { ProductsService } from '../products/products.service';
import { FarmersService } from '../farmers/farmers.service';
import { SubcategoriesService } from '../subcategories/subcategories.service';
import { TenantsService } from '../tenants/tenants.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { ConfigService } from '@nestjs/config';

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
  };
}

const ADMIN_ID = 'admin-uuid-1';

describe('PlatformService', () => {
  let service: PlatformService;
  let db: ReturnType<typeof makeDb>;
  let cacheDel: jest.Mock;

  beforeEach(async () => {
    db = makeDb();
    cacheDel = jest.fn().mockResolvedValue(undefined);
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformService,
        { provide: DB_TOKEN, useValue: db },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('platform-token') },
        },
        { provide: BillingService, useValue: { setPremium: jest.fn().mockResolvedValue(undefined) } },
        { provide: PublicCacheService, useValue: { del: cacheDel } },
        { provide: ConfigService, useValue: { get: (_k: string, d?: any) => (_k === 'EMAIL_COST_PER_RECIPIENT_MICRO' ? 370 : d) } },
        { provide: ProductsService, useValue: { create: jest.fn().mockResolvedValue({ id: 'p' }) } },
        { provide: FarmersService, useValue: { create: jest.fn().mockResolvedValue({ id: 'f' }) } },
        { provide: SubcategoriesService, useValue: { create: jest.fn().mockResolvedValue({ id: 'c' }) } },
        { provide: TenantsService, useValue: { updateSiteContact: jest.fn(), setFavicon: jest.fn() } },
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
});
