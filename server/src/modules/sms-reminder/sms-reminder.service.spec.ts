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
    id: 'o1', phone: '0888123456', orderNumber: 7,
    windowStart: '09:00:00', windowEnd: '11:00:00',
  };

  it('claims, sends, and counts a successful reminder', async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue({ status: 'sent' }) };
    const db = makeDb([baseRow], [true]);
    const svc = new SmsReminderService(db, sms as any);
    const res = await svc.sendForTenant('t1', '2026-07-13');
    expect(sms.sendSms).toHaveBeenCalledWith(
      '0888123456',
      'ФермериБГ: доставка днес на поръчка #7, между 09:00–11:00 ч.',
      { tenantId: 't1', orderId: 'o1', kind: 'delivery_window' },
    );
    expect(res).toMatchObject({ sent: 1, skipped: 0, failed: 0, total: 1 });
  });

  it('skips a row with no phone without claiming', async () => {
    const sms = { sendSms: jest.fn() };
    const db = makeDb([{ ...baseRow, phone: null }], [true]);
    const updateSpy = jest.spyOn(db, 'update');
    const svc = new SmsReminderService(db, sms as any);
    const res = await svc.sendForTenant('t1', '2026-07-13');
    expect(sms.sendSms).not.toHaveBeenCalled();
    // No phone → no claim: db.update must never be touched.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 0, skipped: 1, total: 1 });
  });

  it('skips when the claim is lost (idempotent re-run)', async () => {
    const sms = { sendSms: jest.fn() };
    const db = makeDb([baseRow], [false]);
    const svc = new SmsReminderService(db, sms as any);
    const res = await svc.sendForTenant('t1', '2026-07-13');
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('releases the claim and counts failed when the send fails', async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue({ status: 'failed' }) };
    const db = makeDb([baseRow], [true]);
    const releaseSpy = jest.spyOn(db, 'update');
    const svc = new SmsReminderService(db, sms as any);
    const res = await svc.sendForTenant('t1', '2026-07-13');
    expect(res).toMatchObject({ failed: 1, sent: 0 });
    // update() called twice: once to claim, once to release.
    expect(releaseSpy).toHaveBeenCalledTimes(2);
  });
});
