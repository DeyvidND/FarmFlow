import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
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
  };
}

const USER_ID = 'user-uuid-1';
const TENANT_ID = 'tenant-uuid-1';

describe('AuthService', () => {
  let service: AuthService;
  let db: ReturnType<typeof makeDb>;
  let jwtService: JwtService;

  beforeEach(async () => {
    db = makeDb();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DB_TOKEN, useValue: db },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('signed-token') },
        },
      ],
    }).compile();

    service = module.get(AuthService);
    jwtService = module.get(JwtService);
  });

  // ── changePassword ────────────────────────────────────────────────────────

  describe('changePassword', () => {
    const dto = { currentPassword: 'oldPass1', newPassword: 'newPass1' };
    const userRow = {
      id: USER_ID,
      tenantId: TENANT_ID,
      email: 'u@farm.bg',
      passwordHash: '$argon2id$fake',
      role: 'admin' as const,
      mustChangePassword: true,
    };

    it('returns a new accessToken and clears mustChangePassword when current password is correct', async () => {
      db.limit.mockResolvedValueOnce([userRow]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
      (argon2.hash as jest.Mock).mockResolvedValueOnce('new-hash');
      db.returning.mockResolvedValueOnce([{ ...userRow, mustChangePassword: false }]);

      const result = await service.changePassword(USER_ID, dto);

      expect(result).toEqual({ accessToken: 'signed-token' });
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ mustChangePassword: false }),
      );
    });

    it('throws UnauthorizedException when current password is wrong', async () => {
      db.limit.mockResolvedValueOnce([userRow]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(false);

      await expect(service.changePassword(USER_ID, dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ── getMe ─────────────────────────────────────────────────────────────────

  describe('getMe', () => {
    it('returns email, role and mustChangePassword for the given userId', async () => {
      const userRow = {
        email: 'u@farm.bg',
        role: 'admin' as const,
        mustChangePassword: true,
      };
      db.limit.mockResolvedValueOnce([userRow]);

      const result = await service.getMe(USER_ID);

      expect(result).toEqual({
        email: 'u@farm.bg',
        role: 'admin',
        mustChangePassword: true,
      });
    });
  });

  // ── register no longer exists ──────────────────────────────────────────────

  it('does NOT expose a register method on the service', () => {
    expect(typeof (service as any).register).toBe('undefined');
  });
});
