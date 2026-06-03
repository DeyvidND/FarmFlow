import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PlatformService } from './platform.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

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
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
  };
}

const ADMIN_ID = 'admin-uuid-1';

describe('PlatformService', () => {
  let service: PlatformService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    db = makeDb();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformService,
        { provide: DB_TOKEN, useValue: db },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('platform-token') },
        },
      ],
    }).compile();

    service = module.get(PlatformService);
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

    it('updates the hash and returns void when current password is correct', async () => {
      db.limit.mockResolvedValueOnce([adminRow]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
      (argon2.hash as jest.Mock).mockResolvedValueOnce('new-hash');
      db.returning.mockResolvedValueOnce([{ id: ADMIN_ID }]);

      const result = await service.platformChangePassword(ADMIN_ID, {
        currentPassword: 'correct',
        newPassword: 'newPass1',
      });

      expect(result).toBeUndefined();
    });
  });
});
