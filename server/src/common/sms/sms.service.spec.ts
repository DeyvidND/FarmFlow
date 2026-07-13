import { Logger } from '@nestjs/common';
import { SmsService } from './sms.service';
import { SmsProvider } from './sms.types';

function makeDb() {
  const rows: any[] = [];
  const db = {
    insert: () => ({ values: async (v: any) => { rows.push(v); } }),
  };
  return { db: db as any, rows };
}

describe('SmsService', () => {
  const logger = new Logger('test');

  it('normalizes the phone, sends, and writes a sent log row', async () => {
    const provider: SmsProvider = {
      name: 'http',
      send: jest.fn().mockResolvedValue({ providerMessageId: 'm1', segments: 2 }),
    };
    const { db, rows } = makeDb();
    const svc = new SmsService(db, provider, logger);

    const res = await svc.sendSms('0888123456', 'здравей', { tenantId: 't1', orderId: 'o1' });

    expect(provider.send).toHaveBeenCalledWith('+359888123456', 'здравей');
    expect(res).toEqual({ status: 'sent', providerMessageId: 'm1', segments: 2 });
    expect(rows[0]).toMatchObject({
      tenantId: 't1', orderId: 'o1', phone: '+359888123456',
      provider: 'http', status: 'sent', providerMessageId: 'm1', segments: 2,
      kind: 'delivery_window',
    });
  });

  it('rejects an un-normalisable phone without calling the provider', async () => {
    const provider: SmsProvider = { name: 'http', send: jest.fn() };
    const { db, rows } = makeDb();
    const svc = new SmsService(db, provider, logger);

    const res = await svc.sendSms('123', 'x', { tenantId: 't1' });

    expect(provider.send).not.toHaveBeenCalled();
    expect(res.status).toBe('failed');
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'invalid_phone' });
  });

  it('records a failed row (and does not throw) when the provider throws', async () => {
    const provider: SmsProvider = {
      name: 'http',
      send: jest.fn().mockRejectedValue(new Error('gw 500')),
    };
    const { db, rows } = makeDb();
    const svc = new SmsService(db, provider, logger);

    const res = await svc.sendSms('0888123456', 'здравей');

    expect(res.status).toBe('failed');
    expect(rows[0]).toMatchObject({ status: 'failed', provider: 'http' });
    expect(rows[0].error).toContain('gw 500');
  });
});
