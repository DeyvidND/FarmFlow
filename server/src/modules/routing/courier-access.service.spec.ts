import { ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CourierAccessService } from './courier-access.service';
import { GrantCourierAccessDto } from './dto/courier-access.dto';

jest.mock('argon2', () => ({ hash: jest.fn().mockResolvedValue('hash') }));

function makeDb() {
  const db: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    // revokeAccess runs inside a transaction — run the callback with the same
    // chainable mock so update/delete calls are recorded on `db`.
    transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
  };
  return db;
}

const TENANT = 'tenant-1';

describe('CourierAccessService', () => {
  let db: ReturnType<typeof makeDb>;
  let auth: { issueInvite: jest.Mock };
  let config: { get: jest.Mock };
  let svc: CourierAccessService;

  beforeEach(() => {
    db = makeDb();
    auth = { issueInvite: jest.fn().mockResolvedValue({ link: 'https://app/reset-password?token=x' }) };
    config = { get: jest.fn().mockReturnValue('https://app.example.bg') };
    svc = new CourierAccessService(db as any, auth as any, config as any);
    jest.clearAllMocks();
  });

  describe('listAccess', () => {
    it('returns one entry per driver login, skipping unbound (courierIndex null) drivers', async () => {
      db.where.mockResolvedValueOnce([
        { courierIndex: 0, email: 'a@x.bg', mustChange: true },
        { courierIndex: 1, email: 'b@x.bg', mustChange: false },
        { courierIndex: null, email: 'unbound@x.bg', mustChange: false },
      ]);

      const res = await svc.listAccess(TENANT);

      expect(res).toEqual([
        { courierIndex: 0, email: 'a@x.bg', invitePending: true },
        { courierIndex: 1, email: 'b@x.bg', invitePending: false },
      ]);
    });

    it('returns [] when no driver logins exist', async () => {
      db.where.mockResolvedValueOnce([]);
      const res = await svc.listAccess(TENANT);
      expect(res).toEqual([]);
    });
  });

  describe('grantAccess', () => {
    it('creates a new driver login when the courier leg has none yet', async () => {
      db.limit
        .mockResolvedValueOnce([]) // no existing login for this courierIndex
        .mockResolvedValueOnce([]); // email not taken
      db.returning.mockResolvedValueOnce([{ id: 'user-1' }]); // insert user

      const res = await svc.grantAccess(TENANT, 2, 'Kurier@Example.BG ');

      expect(db.insert).toHaveBeenCalled();
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          role: 'driver',
          courierIndex: 2,
          email: 'kurier@example.bg',
          mustChangePassword: true,
          passwordHash: 'hash',
        }),
      );
      expect(auth.issueInvite).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ email: true }),
      );
      expect(res).toEqual({ courierIndex: 2, loginEmail: 'kurier@example.bg', invitePending: true });
    });

    it('re-invite: updates the existing row instead of inserting a second one', async () => {
      db.limit
        .mockResolvedValueOnce([{ id: 'user-1', courierIndex: 2, email: 'old@x.bg' }]) // existing login
        .mockResolvedValueOnce([]); // email not taken by anyone else
      db.returning.mockResolvedValueOnce([{ id: 'user-1' }]); // update returning

      const res = await svc.grantAccess(TENANT, 2, 'new@x.bg');

      expect(db.update).toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new@x.bg', mustChangePassword: true }),
      );
      expect(auth.issueInvite).toHaveBeenCalledWith('user-1', expect.anything());
      expect(res).toEqual({ courierIndex: 2, loginEmail: 'new@x.bg', invitePending: true });
    });

    it('rejects when the target email belongs to a different user', async () => {
      db.limit
        .mockResolvedValueOnce([]) // no existing login for this courierIndex
        .mockResolvedValueOnce([{ id: 'other-user' }]); // email taken by someone else

      await expect(svc.grantAccess(TENANT, 3, 'taken@x.bg')).rejects.toThrow(ConflictException);
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(auth.issueInvite).not.toHaveBeenCalled();
    });

    it('allows re-inviting with the same email (collision check ignores its own row)', async () => {
      db.limit
        .mockResolvedValueOnce([{ id: 'user-1', courierIndex: 2, email: 'same@x.bg' }]) // existing login
        .mockResolvedValueOnce([{ id: 'user-1' }]); // email owner IS this same login
      db.returning.mockResolvedValueOnce([{ id: 'user-1' }]);

      const res = await svc.grantAccess(TENANT, 2, 'same@x.bg');

      expect(res).toEqual({ courierIndex: 2, loginEmail: 'same@x.bg', invitePending: true });
    });

    it('maps a DB unique-violation on insert (concurrent grant race for the same leg) to a friendly ConflictException', async () => {
      db.limit
        .mockResolvedValueOnce([]) // this request's own read sees no existing login yet
        .mockResolvedValueOnce([]); // email not taken
      const uniqueViolation = Object.assign(
        new Error('duplicate key value violates unique constraint "users_tenant_courier_index_uniq"'),
        { code: '23505' },
      );
      db.returning.mockRejectedValueOnce(uniqueViolation);

      await expect(svc.grantAccess(TENANT, 2, 'driver2@x.bg')).rejects.toThrow(ConflictException);
      expect(auth.issueInvite).not.toHaveBeenCalled();
    });

    it('still returns pending when the invite email fails (swallow + log)', async () => {
      db.limit
        .mockResolvedValueOnce([]) // no existing login
        .mockResolvedValueOnce([]); // email not taken
      db.returning.mockResolvedValueOnce([{ id: 'user-1' }]);
      auth.issueInvite.mockRejectedValueOnce(new Error('smtp down'));

      const res = await svc.grantAccess(TENANT, 4, 'driver4@x.bg');

      expect(res).toEqual({ courierIndex: 4, loginEmail: 'driver4@x.bg', invitePending: true });
    });
  });

  describe('revokeAccess', () => {
    it('bumps token_version, nulls FK refs, then deletes the login — all in one transaction', async () => {
      db.limit.mockResolvedValueOnce([{ id: 'user-1' }]); // existing login lookup

      const res = await svc.revokeAccess(TENANT, 2);

      expect(db.transaction).toHaveBeenCalled();
      expect(db.update).toHaveBeenCalledTimes(3); // tokenVersion bump + auditLogs + orders
      expect(db.set).toHaveBeenCalledWith({ userId: null });
      expect(db.set).toHaveBeenCalledWith({ customerId: null });
      expect(db.delete).toHaveBeenCalled();
      expect(res).toEqual({ ok: true });
    });

    it('throws NotFoundException when the courier leg has no login', async () => {
      db.limit.mockResolvedValueOnce([]); // no login

      await expect(svc.revokeAccess(TENANT, 5)).rejects.toThrow(NotFoundException);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });
  });
});

describe('GrantCourierAccessDto validation', () => {
  it('rejects a courierIndex outside 0-9', async () => {
    const dto = plainToInstance(GrantCourierAccessDto, { courierIndex: 10, email: 'a@x.bg' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'courierIndex')).toBe(true);
  });

  it('rejects a negative courierIndex', async () => {
    const dto = plainToInstance(GrantCourierAccessDto, { courierIndex: -1, email: 'a@x.bg' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'courierIndex')).toBe(true);
  });

  it('accepts a valid payload', async () => {
    const dto = plainToInstance(GrantCourierAccessDto, { courierIndex: 0, email: 'a@x.bg' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
