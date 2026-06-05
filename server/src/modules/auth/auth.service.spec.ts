import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';

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
  let emailMock: { sendMail: jest.Mock };

  beforeEach(async () => {
    db = makeDb();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DB_TOKEN, useValue: db },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('signed-token'),
            signAsync: jest.fn().mockResolvedValue('reset-token'),
            verifyAsync: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(), getOrThrow: jest.fn().mockReturnValue('test-secret') },
        },
        { provide: EmailService, useValue: { sendMail: jest.fn() } },
      ],
    }).compile();

    service = module.get(AuthService);
    jwtService = module.get(JwtService);
    emailMock = module.get(EmailService);
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

  // ── requestPasswordReset ────────────────────────────────────────────────────

  describe('requestPasswordReset', () => {
    const userRow = {
      id: USER_ID,
      tenantId: TENANT_ID,
      email: 'u@farm.bg',
      passwordHash: '$argon2id$fake',
      role: 'admin' as const,
      mustChangePassword: false,
    };

    it('emails a reset link signed with the separate reset secret when the user exists', async () => {
      db.limit.mockResolvedValueOnce([userRow]);

      const res = await service.requestPasswordReset(userRow.email);

      expect(res).toEqual({ ok: true });
      expect(jwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ sub: USER_ID, type: 'reset' }),
        expect.objectContaining({ secret: 'test-secret::pwreset', expiresIn: '30m' }),
      );
      expect(emailMock.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: userRow.email,
          subject: expect.stringContaining('парола'),
        }),
      );
      // The emailed link must carry the signed token (jwt mock returns 'reset-token').
      const sent = emailMock.sendMail.mock.calls[0][0];
      expect(sent.html).toContain('reset-token');
      expect(sent.text).toContain('reset-token');
    });

    it('returns ok without sending when the email is unknown (no enumeration)', async () => {
      db.limit.mockResolvedValueOnce([]); // no user

      const res = await service.requestPasswordReset('ghost@farm.bg');

      expect(res).toEqual({ ok: true });
      expect(jwtService.signAsync).not.toHaveBeenCalled();
      expect(emailMock.sendMail).not.toHaveBeenCalled();
    });

    it('swallows email-send failures and still returns ok', async () => {
      db.limit.mockResolvedValueOnce([userRow]);
      emailMock.sendMail.mockRejectedValueOnce(new Error('smtp down'));

      await expect(service.requestPasswordReset(userRow.email)).resolves.toEqual({ ok: true });
    });
  });

  // ── resetPassword ────────────────────────────────────────────────────────────

  describe('resetPassword', () => {
    const passwordHash = '$argon2id$fake';
    const fingerprint = createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
    const userRow = {
      id: USER_ID,
      tenantId: TENANT_ID,
      email: 'u@farm.bg',
      passwordHash,
      role: 'admin' as const,
      mustChangePassword: false,
    };

    it('sets a new password for a valid token whose fingerprint matches', async () => {
      (jwtService.verifyAsync as jest.Mock).mockResolvedValueOnce({
        sub: USER_ID,
        type: 'reset',
        pv: fingerprint,
      });
      db.limit.mockResolvedValueOnce([userRow]);
      (argon2.hash as jest.Mock).mockResolvedValueOnce('new-hash');

      const res = await service.resetPassword('tok', 'newPass1');

      expect(res).toEqual({ ok: true });
      expect(argon2.hash).toHaveBeenCalledWith('newPass1');
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({ passwordHash: 'new-hash', mustChangePassword: false }),
      );
    });

    it('rejects an invalid or expired token', async () => {
      (jwtService.verifyAsync as jest.Mock).mockRejectedValueOnce(new Error('bad token'));

      await expect(service.resetPassword('tok', 'newPass1')).rejects.toThrow(BadRequestException);
    });

    it('rejects a token whose type is not "reset"', async () => {
      (jwtService.verifyAsync as jest.Mock).mockResolvedValueOnce({ sub: USER_ID, type: 'tenant' });

      await expect(service.resetPassword('tok', 'newPass1')).rejects.toThrow(BadRequestException);
    });

    it('rejects when the password fingerprint no longer matches (token already used)', async () => {
      (jwtService.verifyAsync as jest.Mock).mockResolvedValueOnce({
        sub: USER_ID,
        type: 'reset',
        pv: 'stale-fingerprint',
      });
      db.limit.mockResolvedValueOnce([userRow]);

      await expect(service.resetPassword('tok', 'newPass1')).rejects.toThrow(BadRequestException);
      expect(argon2.hash).not.toHaveBeenCalled();
    });
  });

  // ── register no longer exists ──────────────────────────────────────────────

  it('does NOT expose a register method on the service', () => {
    expect(typeof (service as any).register).toBe('undefined');
  });
});
