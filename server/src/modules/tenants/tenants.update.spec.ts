import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantsService } from './tenants.service';

/**
 * getMe / updateMe — the service methods no existing tenant spec constructs the
 * service to exercise (the others cover the pure site-copy / landing / delivery-
 * secrets helpers in isolation). The risk here is the settings jsonb merge: a save
 * that touches `delivery` must NOT drop the tenant's other settings keys, and a
 * changed farm address must clear a now-stale pin rather than keep routing from
 * the wrong origin.
 *
 * Mock: `.limit()` resolves to the next queued select result; `update().set()`
 * captures the write and `.returning()` yields the queued row.
 */
function makeDb(selects: unknown[][], updateRow: Record<string, unknown>) {
  let i = 0;
  const captured: { set?: Record<string, unknown> } = {};

  const qb: any = {};
  qb.select = jest.fn(() => qb);
  qb.from = jest.fn(() => qb);
  qb.where = jest.fn(() => qb);
  qb.limit = jest.fn(async () => selects[i++] ?? []);

  const upd: any = {};
  upd.set = jest.fn((s: Record<string, unknown>) => {
    captured.set = s;
    return upd;
  });
  upd.where = jest.fn(() => upd);
  upd.returning = jest.fn(async () => [updateRow]);

  qb.update = jest.fn(() => upd);
  return { db: qb, captured };
}

const maps = (geo: { lat: number; lng: number } | null = null) => ({
  geocode: jest.fn().mockResolvedValue(geo),
});
const publicCache = () => ({ del: jest.fn(), resolveTenant: jest.fn() });

const svcWith = (db: unknown, m: unknown, pc: unknown) =>
  new TenantsService(
    db as never,
    m as never,
    pc as never,
    {} as never, // storage
    {} as never, // stripe
    {} as never, // jwt
    {} as never, // config
  );

describe('TenantsService.getMe', () => {
  it('404s when the tenant row is missing', async () => {
    const { db } = makeDb([[]], {});
    const svc = svcWith(db, maps(), publicCache());
    await expect(svc.getMe('t1')).rejects.toThrow(NotFoundException);
  });

  it('surfaces delivery from settings but strips carrier secrets', async () => {
    const row = {
      id: 't1',
      slug: 'shop',
      name: 'Ферма',
      stripeAccountId: null,
      settings: { delivery: { econt: { username: 'u', passwordEnc: 'cipher' } } },
    };
    const { db } = makeDb([[row]], {});
    const svc = svcWith(db, maps(), publicCache());

    const me: any = await svc.getMe('t1');

    expect(me.delivery.econt.username).toBe('u');
    expect(me.delivery.econt.passwordEnc).toBeUndefined();
    expect(me.stripeAccountId).toBeUndefined();
  });
});

describe('TenantsService.updateMe', () => {
  const baseRow = { id: 't1', slug: 'shop', name: 'Ферма', stripeAccountId: null, settings: {} };

  it('rejects a «Продукт на седмицата» from another tenant', async () => {
    // product lookup returns empty → foreign id.
    const { db } = makeDb([[]], baseRow);
    const svc = svcWith(db, maps(), publicCache());

    await expect(
      svc.updateMe('t1', { productOfWeekId: 'foreign' } as never),
    ).rejects.toThrow(BadRequestException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('geocodes a changed farm address and stores the pin', async () => {
    const { db, captured } = makeDb([], baseRow);
    const m = maps({ lat: 42.5, lng: 27.4 });
    const svc = svcWith(db, m, publicCache());

    await svc.updateMe('t1', { farmAddress: 'Бургас, ул. 1' } as never);

    expect(m.geocode).toHaveBeenCalledWith('Бургас, ул. 1');
    expect(captured.set).toMatchObject({ farmLat: '42.5', farmLng: '27.4' });
  });

  it('clears a stale pin when geocoding the new address fails', async () => {
    const { db, captured } = makeDb([], baseRow);
    const m = maps(null); // geocode miss
    const svc = svcWith(db, m, publicCache());

    await svc.updateMe('t1', { farmAddress: 'нечетим адрес' } as never);

    expect(captured.set?.farmLat).toBeNull();
    expect(captured.set?.farmLng).toBeNull();
  });

  it('merges delivery into settings without dropping other keys', async () => {
    const existing = { marketing: { ga4: 'G-1' }, delivery: { econt: { configured: true } } };
    // [0] current-settings read for the jsonb merge.
    const { db, captured } = makeDb([[{ settings: existing }]], baseRow);
    const svc = svcWith(db, maps(), publicCache());

    await svc.updateMe('t1', { delivery: { speedy: { enabled: true } } } as never);

    const set = captured.set as { settings: Record<string, any> };
    // Untouched key preserved; delivery rewritten.
    expect(set.settings.marketing).toEqual({ ga4: 'G-1' });
    expect(set.settings.delivery).toBeDefined();
  });

  it('busts the profile + farmers + subcategories caches on save', async () => {
    const { db } = makeDb([], baseRow);
    const pc = publicCache();
    const svc = svcWith(db, maps(), pc);

    await svc.updateMe('t1', { name: 'Ново име' } as never);

    expect(pc.del).toHaveBeenCalledTimes(1);
    expect(pc.del.mock.calls[0]).toHaveLength(3);
  });
});
