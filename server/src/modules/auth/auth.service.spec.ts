import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
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

    it('preserves farmerId in the re-issued token for a producer sub-account', async () => {
      const farmerRow = { ...userRow, role: 'farmer' as const, farmerId: 'farmer-1' };
      db.limit.mockResolvedValueOnce([farmerRow]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
      (argon2.hash as jest.Mock).mockResolvedValueOnce('new-hash');
      db.returning.mockResolvedValueOnce([{ ...farmerRow, mustChangePassword: false }]);

      await service.changePassword(USER_ID, dto);

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'farmer', farmerId: 'farmer-1' }),
      );
    });
  });

  // ── getMe ─────────────────────────────────────────────────────────────────

  describe('getMe', () => {
    it('returns email, role, mustChangePassword, hiddenNav and farmerId for the given userId', async () => {
      const userRow = {
        email: 'u@farm.bg',
        role: 'admin' as const,
        mustChangePassword: true,
        hiddenNav: ['/orders', 'group:Каталог'],
        farmerId: null,
      };
      db.limit.mockResolvedValueOnce([userRow]);

      const result = await service.getMe(USER_ID);

      expect(result).toEqual({
        email: 'u@farm.bg',
        role: 'admin',
        mustChangePassword: true,
        hiddenNav: ['/orders', 'group:Каталог'],
        farmerId: null,
      });
    });

    it('includes farmerId for a producer sub-account', async () => {
      db.limit.mockResolvedValueOnce([
        { email: 'p@farm.bg', role: 'farmer' as const, mustChangePassword: false, hiddenNav: [], farmerId: 'farmer-1' },
      ]);

      const result = await service.getMe(USER_ID);

      expect(result.farmerId).toBe('farmer-1');
    });

    it('defaults hiddenNav to an empty array when the column is null', async () => {
      db.limit.mockResolvedValueOnce([
        { email: 'u@farm.bg', role: 'admin' as const, mustChangePassword: false, hiddenNav: null, farmerId: null },
      ]);

      const result = await service.getMe(USER_ID);

      expect(result.hiddenNav).toEqual([]);
    });

    it('throws UnauthorizedException when the user is gone', async () => {
      db.limit.mockResolvedValueOnce([]);

      await expect(service.getMe(USER_ID)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── updateHiddenNav ─────────────────────────────────────────────────────────

  describe('updateHiddenNav', () => {
    it('persists the hidden keys and returns them', async () => {
      const hidden = ['/payments', 'group:Маркетинг'];
      db.returning.mockResolvedValueOnce([{ hiddenNav: hidden }]);

      const result = await service.updateHiddenNav(USER_ID, hidden);

      expect(db.set).toHaveBeenCalledWith({ hiddenNav: hidden });
      expect(result).toEqual({ hiddenNav: hidden });
    });

    it('throws UnauthorizedException when no row is updated', async () => {
      db.returning.mockResolvedValueOnce([]);

      await expect(service.updateHiddenNav(USER_ID, [])).rejects.toThrow(UnauthorizedException);
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

  // ── login ─────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('signs a token carrying farmerId for a producer sub-account', async () => {
      db.limit.mockResolvedValueOnce([{
        id: USER_ID, tenantId: TENANT_ID, email: 'p@farm.bg',
        passwordHash: '$argon2id$fake', role: 'farmer', mustChangePassword: false,
        tokenVersion: 0, farmerId: 'farmer-1',
      }]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);

      await service.login({ email: 'p@farm.bg', password: 'x' });

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'farmer', farmerId: 'farmer-1', tenantId: TENANT_ID }),
      );
    });

    it('omits farmerId for an owner token', async () => {
      db.limit.mockResolvedValueOnce([{
        id: USER_ID, tenantId: TENANT_ID, email: 'o@farm.bg',
        passwordHash: '$argon2id$fake', role: 'admin', mustChangePassword: false,
        tokenVersion: 0, farmerId: null,
      }]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);

      await service.login({ email: 'o@farm.bg', password: 'x' });

      const payload = (jwtService.sign as jest.Mock).mock.calls[0][0];
      expect(payload.farmerId).toBeUndefined();
    });
  });

  // ── sendFarmerInvite ────────────────────────────────────────────────────────

  describe('sendFarmerInvite', () => {
    const userRow = {
      id: USER_ID, tenantId: TENANT_ID, email: 'p@farm.bg',
      passwordHash: '$argon2id$fake', role: 'farmer' as const, mustChangePassword: true,
    };

    it('signs a reset token and emails a set-password invite', async () => {
      db.limit.mockResolvedValueOnce([userRow]);

      await service.sendFarmerInvite(USER_ID);

      expect(jwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ sub: USER_ID, type: 'reset' }),
        // 7d is a deliberate security property (longer than a self-service reset) —
        // pin it so a regression to '30m'/no-expiry can't pass silently.
        expect.objectContaining({ secret: 'test-secret::pwreset', expiresIn: '7d' }),
      );
      const sent = emailMock.sendMail.mock.calls[0][0];
      expect(sent.to).toBe('p@farm.bg');
      expect(sent.html).toContain('reset-token');
      expect(sent.text).toContain('reset-token');
    });

    it('throws NotFoundException when the user does not exist', async () => {
      db.limit.mockResolvedValueOnce([]);
      await expect(service.sendFarmerInvite(USER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  // ── issueInvite (app-targeted, reusable invite link) ─────────────────────────

  describe('issueInvite', () => {
    const userRow = {
      id: USER_ID, tenantId: TENANT_ID, email: 'op@dostavki.bg',
      passwordHash: '$argon2id$fake', role: 'admin' as const, mustChangePassword: true,
    };

    it('signs a 7d reset token, builds a link at the given appUrl, and returns it', async () => {
      db.limit.mockResolvedValueOnce([userRow]);

      const res = await service.issueInvite(USER_ID, { appUrl: 'https://dostavki.fermeribg.com/' });

      expect(jwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ sub: USER_ID, type: 'reset' }),
        expect.objectContaining({ secret: 'test-secret::pwreset', expiresIn: '7d' }),
      );
      // Trailing slash on the appUrl is stripped; token is URL-encoded into the link.
      expect(res.link).toBe('https://dostavki.fermeribg.com/reset-password?token=reset-token');
      // email defaults to off → no send.
      expect(emailMock.sendMail).not.toHaveBeenCalled();
    });

    it('emails the invite when email:true (using the delivery subject/copy)', async () => {
      db.limit.mockResolvedValueOnce([userRow]);

      await service.issueInvite(USER_ID, { appUrl: 'https://dostavki.fermeribg.com', email: true });

      const sent = emailMock.sendMail.mock.calls[0][0];
      expect(sent.to).toBe('op@dostavki.bg');
      expect(sent.html).toContain('reset-token');
      expect(sent.text).toContain('reset-token');
    });

    it('still returns the link when the email send fails (best-effort email)', async () => {
      db.limit.mockResolvedValueOnce([userRow]);
      emailMock.sendMail.mockRejectedValueOnce(new Error('smtp down'));

      const res = await service.issueInvite(USER_ID, { appUrl: 'https://dostavki.fermeribg.com', email: true });
      expect(res.link).toContain('reset-password?token=reset-token');
    });

    it('throws NotFoundException when the user does not exist', async () => {
      db.limit.mockResolvedValueOnce([]);
      await expect(
        service.issueInvite(USER_ID, { appUrl: 'https://dostavki.fermeribg.com' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── register no longer exists ──────────────────────────────────────────────

  it('does NOT expose a register method on the service', () => {
    expect(typeof (service as any).register).toBe('undefined');
  });

  // ── delivery handoff (SSO to dostavki) ─────────────────────────────────────
  describe('delivery handoff', () => {
    it('issueDeliveryHandoff signs a typed, short-TTL token with the derived secret', async () => {
      (jwtService.signAsync as jest.Mock).mockResolvedValueOnce('handoff-token');
      const out = await service.issueDeliveryHandoff(USER_ID, TENANT_ID);
      expect(out).toEqual({ token: 'handoff-token' });
      expect(jwtService.signAsync).toHaveBeenCalledWith(
        { sub: USER_ID, tid: TENANT_ID, type: 'delivery-handoff' },
        { secret: 'test-secret::handoff', expiresIn: '120s' },
      );
    });

    it('handoffLogin rejects an invalid/expired token', async () => {
      (jwtService.verifyAsync as jest.Mock).mockRejectedValueOnce(new Error('bad'));
      await expect(service.handoffLogin('x')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('handoffLogin rejects a token of the wrong type', async () => {
      (jwtService.verifyAsync as jest.Mock).mockResolvedValueOnce({ sub: USER_ID, type: 'tenant' });
      await expect(service.handoffLogin('x')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('handoffLogin denies a tenant without the deliveries package', async () => {
      (jwtService.verifyAsync as jest.Mock).mockResolvedValueOnce({ sub: USER_ID, type: 'delivery-handoff' });
      db.limit
        .mockResolvedValueOnce([{ id: USER_ID, tenantId: TENANT_ID, role: 'admin', tokenVersion: 0 }])
        .mockResolvedValueOnce([{ pkg: false }]);
      await expect(service.handoffLogin('x')).rejects.toMatchObject({ status: 403 });
    });

    it('handoffLogin issues a session when valid and the package is on', async () => {
      (jwtService.verifyAsync as jest.Mock).mockResolvedValueOnce({ sub: USER_ID, type: 'delivery-handoff' });
      db.limit
        .mockResolvedValueOnce([
          { id: USER_ID, tenantId: TENANT_ID, role: 'admin', tokenVersion: 0, mustChangePassword: false, farmerId: null },
        ])
        .mockResolvedValueOnce([{ pkg: true }]);
      const out = await service.handoffLogin('x');
      expect(out).toEqual({ accessToken: 'signed-token' });
    });

    it('includes farmerId in the handoff token when the user is a farmer', async () => {
      (jwtService.signAsync as jest.Mock).mockResolvedValueOnce('handoff-token');
      await service.issueDeliveryHandoff(USER_ID, TENANT_ID, 'farmer-1');
      expect(jwtService.signAsync).toHaveBeenCalledWith(
        { sub: USER_ID, tid: TENANT_ID, fid: 'farmer-1', type: 'delivery-handoff' },
        expect.objectContaining({ expiresIn: '120s' }),
      );
    });
  });
});
