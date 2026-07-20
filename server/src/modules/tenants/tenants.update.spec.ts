import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { TenantsService } from './tenants.service';

/**
 * updateMe now writes touched settings sub-keys with an ATOMIC nested jsonbDeepMerge
 * (not a whole-blob read-modify-write), so `captured.set.settings` is an SQL
 * expression rather than a JS object. Render it and apply the SAME coalesce/|| merge
 * Postgres runs against the starting settings, so the effective result can be
 * asserted (proving touched keys land AND untouched siblings survive) without a DB.
 */
const dialect = new PgDialect();
function mergedSettings(
  capturedSet: Record<string, unknown> | undefined,
  existing: Record<string, any>,
): Record<string, any> {
  const { params } = dialect.sqlToQuery((capturedSet as any)?.settings);
  let result: Record<string, any> = { ...existing };
  // Each touched top-level key contributes one (key, jsonValue) pair; pair every
  // JSON-object leaf param with the nearest preceding key param.
  for (let n = 0; n < params.length; n++) {
    const p = params[n];
    if (typeof p === 'string' && p.trim().startsWith('{')) {
      let key: string | undefined;
      for (let m = n - 1; m >= 0; m--) {
        const q = params[m];
        if (typeof q === 'string' && !q.trim().startsWith('{')) { key = q; break; }
      }
      if (key) result = { ...result, [key]: JSON.parse(p) };
    }
  }
  return result;
}

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

  it('strips Stripe/billing fields for the driver role but keeps them for admin/farmer', async () => {
    const row = {
      id: 't1',
      slug: 'shop',
      name: 'Ферма',
      stripeAccountId: 'acct_1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      subscriptionStatus: 'past_due',
      subscriptionSince: '2026-01-01',
      premium: true,
      graceUntil: '2026-08-01',
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeDetailsSubmitted: true,
      stripeStatusUpdatedAt: '2026-07-01',
      settings: {},
    };
    const billingFields = [
      'stripeCustomerId', 'stripeSubscriptionId', 'subscriptionStatus', 'subscriptionSince',
      'premium', 'graceUntil', 'stripeChargesEnabled', 'stripePayoutsEnabled',
      'stripeDetailsSubmitted', 'stripeStatusUpdatedAt',
    ] as const;

    const driverDb = makeDb([[row]], {}).db;
    const driverMe: any = await svcWith(driverDb, maps(), publicCache()).getMe('t1', 'driver');
    for (const f of billingFields) expect(driverMe[f]).toBeUndefined();
    expect(driverMe.stripeAccountId).toBeUndefined(); // always stripped, regardless of role

    const adminDb = makeDb([[row]], {}).db;
    const adminMe: any = await svcWith(adminDb, maps(), publicCache()).getMe('t1', 'admin');
    expect(adminMe.subscriptionStatus).toBe('past_due');
    expect(adminMe.premium).toBe(true);
    expect(adminMe.graceUntil).toBe('2026-08-01');
    expect(adminMe.stripeCustomerId).toBe('cus_1');
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

    const result = mergedSettings(captured.set, existing);
    // Untouched key preserved; delivery rewritten.
    expect(result.marketing).toEqual({ ga4: 'G-1' });
    expect(result.delivery).toBeDefined();
  });

  it('merges sms.dayOfReminder into settings without dropping other keys', async () => {
    const existing = { delivery: { foo: 1 }, media: { hero: {} } };
    const { db, captured } = makeDb([[{ settings: existing }]], baseRow);
    const svc = svcWith(db, maps(), publicCache());

    await svc.updateMe('t1', { sms: { dayOfReminder: true } } as never);

    expect(mergedSettings(captured.set, existing)).toMatchObject({
      delivery: { foo: 1 },
      media: { hero: {} },
      sms: { dayOfReminder: true },
    });
  });

  it('merges sms.sendHour without clobbering an existing dayOfReminder (partial update)', async () => {
    const existing = { sms: { dayOfReminder: true, channel: 'email' } };
    const { db, captured } = makeDb([[{ settings: existing }]], baseRow);
    const svc = svcWith(db, maps(), publicCache());

    // Payload carries ONLY sendHour — the stored master flag + channel survive.
    await svc.updateMe('t1', { sms: { sendHour: 6 } } as never);

    const result = mergedSettings(captured.set, existing);
    expect(result.sms).toEqual({
      dayOfReminder: true,
      channel: 'email',
      sendHour: 6,
    });
  });

  it('ignores an out-of-range sms.sendHour, leaving the stored value intact', async () => {
    const existing = { sms: { dayOfReminder: true, sendHour: 8 } };
    const { db, captured } = makeDb([[{ settings: existing }]], baseRow);
    const svc = svcWith(db, maps(), publicCache());

    await svc.updateMe('t1', { sms: { sendHour: 99 } } as never);

    const result = mergedSettings(captured.set, existing);
    expect(result.sms).toEqual({ dayOfReminder: true, sendHour: 8 });
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
