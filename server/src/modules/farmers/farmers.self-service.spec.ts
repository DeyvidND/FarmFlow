import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { FarmersController } from './farmers.controller';
import { FarmersService } from './farmers.service';

const TENANT = 'tenant-1';
const SELF = 'farmer-self';
const OTHER = 'farmer-other';

/**
 * The producer self-service surface (`/farmers/me*`) is the ONLY write path a
 * non-admin has into the farmers table, so these tests are about the boundary,
 * not the happy path: which row is targeted, and which columns may be written.
 */

/** Captures what reached `.set()` and renders the `.where()` condition to real SQL
 *  (a mock that ignores WHERE certifies the bug instead of catching it — and drizzle
 *  condition objects are circular, so they must be rendered, never deep-compared). */
function dbMock(row: Record<string, unknown> | null = { id: SELF, tenantId: TENANT }) {
  const dialect = new PgDialect();
  const calls: { set?: Record<string, unknown>; whereSql?: string } = {};
  const update = jest.fn(() => ({
    set: (v: Record<string, unknown>) => {
      calls.set = v;
      return {
        where: (cond: any) => {
          calls.whereSql = dialect.sqlToQuery(cond).sql;
          return { returning: async () => (row ? [row] : []) };
        },
      };
    },
  }));
  const select = jest.fn(() => ({
    from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
  }));
  return { calls, update, select };
}

function make(db: ReturnType<typeof dbMock>) {
  const cache = { invalidate: jest.fn() };
  const publicCache = { del: jest.fn() };
  return {
    cache,
    publicCache,
    svc: new FarmersService(db as any, {} as any, cache as any, publicCache as any, {} as any, {} as any),
  };
}

describe('FarmersService.updateMe', () => {
  it('writes ONLY the allow-listed columns, dropping anything else the body carried', async () => {
    const db = dbMock();
    const { svc } = make(db);

    // A hostile body: the commercial + catalog fields a producer must never own.
    await svc.updateMe(SELF, TENANT, {
      phone: '+359 88 000 0001',
      email: 'me@ferma.bg',
      legal: { name: 'ЕТ „Петров"', eik: '203912345' },
      commissionRateBps: 0,
      subscriptionFeeStotinki: 0,
      internalNotes: 'hacked',
      payout: { iban: 'BG00ATTACKER' },
      tier: 'premium',
      position: 0,
      name: 'Друго име',
      tenantId: 'other-tenant',
    } as any);

    expect(Object.keys(db.calls.set!).sort()).toEqual(['email', 'legal', 'phone']);
    expect(db.calls.set).toMatchObject({
      phone: '+359 88 000 0001',
      email: 'me@ferma.bg',
      legal: { name: 'ЕТ „Петров"', eik: '203912345' },
    });
  });

  it('stamps legal.confirmedAt server-side and ignores a client-supplied one', async () => {
    const db = dbMock();
    const { svc } = make(db);
    const forged = '1999-01-01T00:00:00.000Z';

    await svc.updateMe(SELF, TENANT, {
      legal: { name: 'ЕТ „Петров"', confirmedAt: forged },
    } as any);

    const legal = db.calls.set!.legal as { confirmedAt?: string };
    expect(legal.confirmedAt).toBeDefined();
    expect(legal.confirmedAt).not.toEqual(forged); // audit trail is not client-writable
    expect(new Date(legal.confirmedAt!).toString()).not.toBe('Invalid Date');
  });

  it('scopes the write to BOTH the farmer id and the tenant', async () => {
    const db = dbMock();
    const { svc } = make(db);

    await svc.updateMe(SELF, TENANT, { phone: '+359 88 000 0001' });

    // Rendered SQL, not a structural compare — proves the predicate really shipped.
    expect(db.calls.whereSql).toContain('"id" =');
    expect(db.calls.whereSql).toContain('"tenant_id" =');
  });

  it('is a no-op read on an empty patch (drizzle throws on .set({}))', async () => {
    const db = dbMock();
    const { svc } = make(db);

    await expect(svc.updateMe(SELF, TENANT, {})).resolves.toBeDefined();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('404s instead of silently succeeding when the row is missing / cross-tenant', async () => {
    const db = dbMock(null);
    const { svc } = make(db);

    await expect(svc.updateMe(SELF, TENANT, { phone: '+359 88 000 0001' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('busts the catalog + public caches — `legal` rides the public farmer projection', async () => {
    const db = dbMock();
    const { svc, cache, publicCache } = make(db);

    await svc.updateMe(SELF, TENANT, { legal: { name: 'ЕТ „Петров"' } });

    expect(cache.invalidate).toHaveBeenCalledWith(TENANT);
    expect(publicCache.del).toHaveBeenCalled();
  });

  it('never returns the encrypted signature blob', async () => {
    const db = dbMock({ id: SELF, tenantId: TENANT, name: 'Петър', signaturePng: 'enc:blob:here' });
    const { svc } = make(db);

    const out = await svc.updateMe(SELF, TENANT, { phone: '+359 88 000 0001' });
    expect(out).not.toHaveProperty('signaturePng');
  });
});

describe('FarmersController /farmers/me target resolution', () => {
  /** Every self route must resolve the row from the TOKEN. There is no id param to
   *  tamper with — this pins that, so re-adding one would fail here. */
  const svc = () =>
    ({
      findOne: jest.fn().mockResolvedValue({ id: SELF }),
      updateMe: jest.fn().mockResolvedValue({ id: SELF }),
      getSignature: jest.fn().mockResolvedValue({ signaturePng: null }),
      setSignature: jest.fn().mockResolvedValue({ signaturePng: null }),
    }) as any;

  const token = { role: 'farmer', farmerId: SELF } as any;

  it('reads/writes the token farmer, never another id', async () => {
    const s = svc();
    const ctrl = new FarmersController(s);

    await ctrl.findMe(TENANT, token);
    await ctrl.updateMe(TENANT, token, { phone: '+359 88 000 0001' });
    await ctrl.getMySignature(TENANT, token);
    await ctrl.setMySignature(TENANT, token, { signaturePng: null });

    expect(s.findOne).toHaveBeenCalledWith(SELF, TENANT);
    expect(s.updateMe).toHaveBeenCalledWith(SELF, TENANT, { phone: '+359 88 000 0001' });
    expect(s.getSignature).toHaveBeenCalledWith(SELF, TENANT);
    expect(s.setSignature).toHaveBeenCalledWith(SELF, TENANT, null);

    // The other producer's id appears in no call.
    for (const fn of [s.findOne, s.updateMe, s.getSignature, s.setSignature]) {
      expect(JSON.stringify(fn.mock.calls)).not.toContain(OTHER);
    }
  });

  it('403s a farmer token that carries no farmerId (malformed) instead of falling back', async () => {
    const s = svc();
    const ctrl = new FarmersController(s);
    const bad = { role: 'farmer', farmerId: undefined } as any;

    // Thrown synchronously: `selfId` runs before the handler returns a promise.
    expect(() => ctrl.findMe(TENANT, bad)).toThrow(ForbiddenException);
    expect(() => ctrl.updateMe(TENANT, bad, {})).toThrow(ForbiddenException);
    expect(() => ctrl.getMySignature(TENANT, bad)).toThrow(ForbiddenException);
    expect(() => ctrl.setMySignature(TENANT, bad, {})).toThrow(ForbiddenException);
    expect(s.findOne).not.toHaveBeenCalled();
    expect(s.updateMe).not.toHaveBeenCalled();
  });
});
