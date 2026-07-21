import { ConflictException, NotFoundException } from '@nestjs/common';
import { FarmersService } from './farmers.service';

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
const FARMER = 'farmer-1';

describe('FarmersService access', () => {
  let db: ReturnType<typeof makeDb>;
  let auth: { sendFarmerInvite: jest.Mock };
  let svc: FarmersService;

  beforeEach(() => {
    db = makeDb();
    auth = { sendFarmerInvite: jest.fn().mockResolvedValue(undefined) };
    // Storage/cache deps are unused by the access methods → pass minimal stubs.
    svc = new FarmersService(db as any, {} as any, {} as any, {} as any, auth as any, {} as any, {} as any);
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

describe('FarmersService.remove (frees the login email)', () => {
  let db: ReturnType<typeof makeDb>;
  let svc: FarmersService;
  let cache: { invalidate: jest.Mock };
  let publicCache: { del: jest.Mock };

  beforeEach(() => {
    db = makeDb();
    cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    publicCache = { del: jest.fn().mockResolvedValue(undefined) };
    // storage(2)=cache(3)=publicCache(4); auth(5)/queue(6)/maps(7) unused by remove().
    svc = new FarmersService(db as any, {} as any, cache as any, publicCache as any, {} as any, {} as any, {} as any);
    jest.clearAllMocks();
  });

  it('nulls the login\'s audit/order FK refs before deleting so the cascade frees the email', async () => {
    // Call order of the awaited builders inside remove():
    //   findOne(where→limit) → media(where) → tx{ login(where→limit), updates(where)×2, delete(where) }
    db.where
      .mockReturnValueOnce(db) // findOne: where → limit
      .mockResolvedValueOnce([]) // media query terminal (no gallery rows)
      .mockReturnValueOnce(db) // login lookup: where → limit
      .mockResolvedValueOnce(undefined) // update(auditLogs).set().where()
      .mockResolvedValueOnce(undefined) // update(orders).set().where()
      .mockResolvedValueOnce(undefined); // delete(farmers).where()
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, imageUrl: null }]) // findOne
      .mockResolvedValueOnce([{ id: 'user-1' }]); // the farmer's login

    const res = await svc.remove(FARMER, TENANT);

    expect(db.transaction).toHaveBeenCalled(); // atomic
    // audit_logs.user_id + orders.customer_id nulled (the NO ACTION refs that block the cascade)
    expect(db.update).toHaveBeenCalledTimes(2);
    expect(db.set).toHaveBeenCalledWith({ userId: null });
    expect(db.set).toHaveBeenCalledWith({ customerId: null });
    expect(db.delete).toHaveBeenCalled(); // farmer (cascade-drops the login)
    expect(publicCache.del).toHaveBeenCalled();
    expect(res).toEqual({ id: FARMER });
  });

  it('skips the FK cleanup when the farmer has no login', async () => {
    db.where
      .mockReturnValueOnce(db) // findOne
      .mockResolvedValueOnce([]) // media
      .mockReturnValueOnce(db) // login lookup
      .mockResolvedValueOnce(undefined); // delete(farmers)
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, imageUrl: null }]) // findOne
      .mockResolvedValueOnce([]); // no login

    await svc.remove(FARMER, TENANT);

    expect(db.update).not.toHaveBeenCalled(); // nothing to null
    expect(db.delete).toHaveBeenCalled();
  });
});
