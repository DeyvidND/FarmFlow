import { ConflictException, NotFoundException } from '@nestjs/common';
import { FarmersService } from './farmers.service';

jest.mock('argon2', () => ({ hash: jest.fn().mockResolvedValue('hash') }));

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
    delete: jest.fn().mockReturnThis(),
  };
}

const TENANT = 'tenant-1';
const FARMER = 'farmer-1';

describe('FarmersService access', () => {
  let db: ReturnType<typeof makeDb>;
  let auth: { sendFarmerInvite: jest.Mock };
  let svc: FarmersService;

  beforeEach(() => {
    db = makeDb();
    auth = { sendFarmerInvite: jest.fn().mockResolvedValue(undefined) };
    // Storage/cache deps are unused by the access methods → pass minimal stubs.
    svc = new FarmersService(db as any, {} as any, {} as any, {} as any, auth as any, {} as any);
    jest.clearAllMocks();
  });

  it('grantAccess creates a farmer login and sends the invite', async () => {
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, name: 'Иван' }]) // findOne
      .mockResolvedValueOnce([]) // no existing login for this farmer
      .mockResolvedValueOnce([]); // email not taken
    db.returning.mockResolvedValueOnce([{ id: 'user-1' }]); // insert user

    const res = await svc.grantAccess(TENANT, FARMER, 'ivan@farm.bg');

    expect(db.insert).toHaveBeenCalled();
    expect(auth.sendFarmerInvite).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ hasLogin: true, loginEmail: 'ivan@farm.bg', invitePending: true });
  });

  it('grantAccess rejects an email already used by another user', async () => {
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, name: 'Иван' }]) // findOne
      .mockResolvedValueOnce([]) // no existing login for this farmer
      .mockResolvedValueOnce([{ id: 'other-user' }]); // email taken

    await expect(svc.grantAccess(TENANT, FARMER, 'taken@farm.bg')).rejects.toThrow(ConflictException);
    expect(auth.sendFarmerInvite).not.toHaveBeenCalled();
  });

  it('revokeAccess bumps token_version then deletes the login', async () => {
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, name: 'Иван' }]) // findOne
      .mockResolvedValueOnce([{ id: 'user-1' }]); // existing login

    const res = await svc.revokeAccess(TENANT, FARMER);

    expect(db.update).toHaveBeenCalled(); // tokenVersion bump
    expect(db.delete).toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });

  it('revokeAccess 404s when the producer has no login', async () => {
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, name: 'Иван' }]) // findOne
      .mockResolvedValueOnce([]); // no login
    await expect(svc.revokeAccess(TENANT, FARMER)).rejects.toThrow(NotFoundException);
  });

  it('grantAccess still returns pending when the invite email fails', async () => {
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, name: 'Иван' }]) // findOne
      .mockResolvedValueOnce([]) // no existing login
      .mockResolvedValueOnce([]); // email not taken
    db.returning.mockResolvedValueOnce([{ id: 'user-1' }]); // insert user
    auth.sendFarmerInvite.mockRejectedValueOnce(new Error('smtp down'));

    const res = await svc.grantAccess(TENANT, FARMER, 'ivan@farm.bg');

    expect(res).toEqual({ hasLogin: true, loginEmail: 'ivan@farm.bg', invitePending: true });
  });

  it('listAccess maps farmer logins, skipping null farmerId', async () => {
    db.where.mockResolvedValueOnce([
      { farmerId: 'f1', email: 'a@x.bg', mustChange: true },
      { farmerId: 'f2', email: 'b@x.bg', mustChange: false },
      { farmerId: null, email: 'owner@x.bg', mustChange: false },
    ]);
    const res = await svc.listAccess(TENANT);
    expect(res).toEqual({
      f1: { hasLogin: true, loginEmail: 'a@x.bg', invitePending: true },
      f2: { hasLogin: true, loginEmail: 'b@x.bg', invitePending: false },
    });
  });

  it('listAccess returns empty when no farmer logins exist', async () => {
    db.where.mockResolvedValueOnce([]);
    const res = await svc.listAccess(TENANT);
    expect(res).toEqual({});
  });
});
