import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { SmsReminderService, buildBody } from './sms-reminder.service';

describe('buildBody', () => {
  it('formats the Cyrillic reminder', () => {
    expect(buildBody(42, '10:00', '12:00')).toBe(
      'ФермериБГ: доставка днес на поръчка #42, между 10:00–12:00 ч.',
    );
  });
});

describe('SmsReminderService.sendForTenant', () => {
  // Minimal query-builder stub: select() → chainable → resolves to `rows`;
  // update() → chainable → returning() resolves to the claim result. where()
  // renders the real drizzle condition to SQL text (same technique as
  // slots.service.spec.ts's fakeDb) so the stub actually enforces the
  // reminder-opt-out clause instead of blindly returning every row regardless
  // of the WHERE — a test row's `reminderOptOut` stands in for the joined
  // slot's flag (absent/undefined ⇒ a slotless order / LEFT JOIN miss).
  const dialect = new PgDialect();
  function makeDb(rows: any[], claimWins: boolean[]) {
    let claimCall = 0;
    let lastWhereSql = '';
    const select = () => {
      const q: any = {};
      q.from = () => q;
      q.leftJoin = () => q;
      q.where = (cond: unknown) => {
        const sqlText = dialect.sqlToQuery(cond as SQL).sql;
        lastWhereSql = sqlText;
        q._rows = sqlText.includes('"reminder_opt_out"')
          ? rows.filter((r) => r.reminderOptOut !== true)
          : rows;
        return q;
      };
      q.then = (res: any) => res(q._rows ?? rows);
      return q;
    };
    const update = () => {
      const q: any = {};
      q.set = () => q;
      q.where = () => q;
      q.returning = async () => (claimWins[claimCall++] ? [{ id: 'x' }] : []);
      return q;
    };
    // Exposes the actual rendered WHERE SQL from the last select() call, so a
    // test can assert on the *structure* of the production condition (e.g.
    // that it's an isNull-OR-eq, not a bare eq) — not just simulate row
    // filtering in JS, which can't distinguish those two shapes.
    return { select, update, whereSql: () => lastWhereSql } as any;
  }

  const baseRow = {
    id: 'o1', email: 'buyer@example.bg', phone: '0888123456', orderNumber: 7,
    windowStart: '09:00:00', windowEnd: '11:00:00',
  };
  const noopEmail = { sendDeliveryWindowReminder: jest.fn() };

  // ── SMS channel ──────────────────────────────────────────────────────────

  it('sms: claims, sends, and counts a successful reminder', async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue({ status: 'sent' }) };
    const db = makeDb([baseRow], [true]);
    const svc = new SmsReminderService(db, sms as any, noopEmail as any);
    const res = await svc.sendForTenant('t1', 'sms', '2026-07-13');
    expect(sms.sendSms).toHaveBeenCalledWith(
      '0888123456',
      'ФермериБГ: доставка днес на поръчка #7, между 09:00–11:00 ч.',
      { tenantId: 't1', orderId: 'o1', kind: 'delivery_window' },
    );
    expect(res).toMatchObject({ sent: 1, skipped: 0, failed: 0, total: 1 });
  });

  it('sms: skips a row with no phone without claiming', async () => {
    const sms = { sendSms: jest.fn() };
    const db = makeDb([{ ...baseRow, phone: null }], [true]);
    const updateSpy = jest.spyOn(db, 'update');
    const svc = new SmsReminderService(db, sms as any, noopEmail as any);
    const res = await svc.sendForTenant('t1', 'sms', '2026-07-13');
    expect(sms.sendSms).not.toHaveBeenCalled();
    // No phone → no claim: db.update must never be touched.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 0, skipped: 1, total: 1 });
  });

  it('sms: skips when the claim is lost (idempotent re-run)', async () => {
    const sms = { sendSms: jest.fn() };
    const db = makeDb([baseRow], [false]);
    const svc = new SmsReminderService(db, sms as any, noopEmail as any);
    const res = await svc.sendForTenant('t1', 'sms', '2026-07-13');
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('sms: releases the claim and counts failed when the send fails', async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue({ status: 'failed' }) };
    const db = makeDb([baseRow], [true]);
    const releaseSpy = jest.spyOn(db, 'update');
    const svc = new SmsReminderService(db, sms as any, noopEmail as any);
    const res = await svc.sendForTenant('t1', 'sms', '2026-07-13');
    expect(res).toMatchObject({ failed: 1, sent: 0 });
    // update() called twice: once to claim, once to release.
    expect(releaseSpy).toHaveBeenCalledTimes(2);
  });

  // ── Email channel (default) ──────────────────────────────────────────────

  it('email: claims and sends the reminder email (does not touch SMS)', async () => {
    const sms = { sendSms: jest.fn() };
    const orderEmail = { sendDeliveryWindowReminder: jest.fn().mockResolvedValue(undefined) };
    const db = makeDb([baseRow], [true]);
    const svc = new SmsReminderService(db, sms as any, orderEmail as any);
    const res = await svc.sendForTenant('t1', 'email', '2026-07-13');
    expect(orderEmail.sendDeliveryWindowReminder).toHaveBeenCalledWith(
      'o1', '09:00', '11:00', '2026-07-13',
    );
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 1, skipped: 0, failed: 0, total: 1 });
  });

  it('email: skips a row with no email without claiming', async () => {
    const sms = { sendSms: jest.fn() };
    const orderEmail = { sendDeliveryWindowReminder: jest.fn() };
    const db = makeDb([{ ...baseRow, email: null }], [true]);
    const updateSpy = jest.spyOn(db, 'update');
    const svc = new SmsReminderService(db, sms as any, orderEmail as any);
    const res = await svc.sendForTenant('t1', 'email', '2026-07-13');
    expect(orderEmail.sendDeliveryWindowReminder).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 0, skipped: 1, total: 1 });
  });

  it('email: releases the claim and counts failed when the email throws', async () => {
    const sms = { sendSms: jest.fn() };
    const orderEmail = {
      sendDeliveryWindowReminder: jest.fn().mockRejectedValue(new Error('smtp down')),
    };
    const db = makeDb([baseRow], [true]);
    const releaseSpy = jest.spyOn(db, 'update');
    const svc = new SmsReminderService(db, sms as any, orderEmail as any);
    const res = await svc.sendForTenant('t1', 'email', '2026-07-13');
    expect(res).toMatchObject({ failed: 1, sent: 0 });
    // update() called twice: claim, then release after the throw.
    expect(releaseSpy).toHaveBeenCalledTimes(2);
  });

  it('defaults to the email channel when none is passed', async () => {
    const sms = { sendSms: jest.fn() };
    const orderEmail = { sendDeliveryWindowReminder: jest.fn().mockResolvedValue(undefined) };
    const db = makeDb([baseRow], [true]);
    const svc = new SmsReminderService(db, sms as any, orderEmail as any);
    await svc.sendForTenant('t1');
    expect(orderEmail.sendDeliveryWindowReminder).toHaveBeenCalled();
    expect(sms.sendSms).not.toHaveBeenCalled();
  });

  // ── Per-day reminder opt-out (deliverySlots.reminderOptOut) ─────────────────

  it("excludes an order whose delivery day opted out of the reminder (slot's reminderOptOut=true)", async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue({ status: 'sent' }) };
    const optedOutRow = { ...baseRow, id: 'o-opted-out', reminderOptOut: true };
    const db = makeDb([optedOutRow], [true]);
    const svc = new SmsReminderService(db, sms as any, noopEmail as any);
    const res = await svc.sendForTenant('t1', 'sms', '2026-07-13');
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 0, skipped: 0, failed: 0, total: 0 });
  });

  it('still sends a slotless order (no slot join ⇒ reminderOptOut is NULL, not opted out)', async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue({ status: 'sent' }) };
    // baseRow carries no reminderOptOut key at all — mirrors a LEFT JOIN miss
    // (NULL), which or(isNull(...), eq(...,false)) must still let through.
    const db = makeDb([baseRow], [true]);
    const svc = new SmsReminderService(db, sms as any, noopEmail as any);
    const res = await svc.sendForTenant('t1', 'sms', '2026-07-13');
    expect(sms.sendSms).toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 1, total: 1 });
    // Structural proof, not just a JS-level row-filter outcome: the actual
    // rendered WHERE clause must contain isNull(reminder_opt_out) — i.e.
    // `"reminder_opt_out" is null` — alongside the eq. A regression to a bare
    // eq(deliverySlots.reminderOptOut, false) (which would silently drop this
    // exact slotless-order case in real Postgres, since NULL = false is
    // UNKNOWN) removes that `is null` text even though the mock's row filter
    // above can't tell the two shapes apart. This assertion can.
    expect(db.whereSql()).toMatch(/"reminder_opt_out"\s+is\s+null/i);
  });
});
