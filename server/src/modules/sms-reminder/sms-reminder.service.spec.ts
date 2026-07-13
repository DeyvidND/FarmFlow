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
  // update() → chainable → returning() resolves to the claim result.
  function makeDb(rows: any[], claimWins: boolean[]) {
    let claimCall = 0;
    const select = () => {
      const q: any = {};
      for (const m of ['from', 'leftJoin', 'where']) q[m] = () => q;
      q.then = (res: any) => res(rows);
      return q;
    };
    const update = () => {
      const q: any = {};
      q.set = () => q;
      q.where = () => q;
      q.returning = async () => (claimWins[claimCall++] ? [{ id: 'x' }] : []);
      return q;
    };
    return { select, update } as any;
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
});
