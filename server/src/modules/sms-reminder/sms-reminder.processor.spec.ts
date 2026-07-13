import { SmsReminderProcessor } from './sms-reminder.processor';

describe('SmsReminderProcessor', () => {
  function makeQueue() {
    const added: any[] = [];
    return { added, add: jest.fn(async (name, data, opts) => { added.push({ name, data, opts }); }) };
  }

  it('registers the 08:00 Europe/Sofia repeatable on boot', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenantIds: jest.fn(), sendForTenant: jest.fn() };
    const p = new SmsReminderProcessor(svc as any, queue as any);
    await p.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      'sms-daily', {},
      expect.objectContaining({ repeat: { pattern: '0 8 * * *', tz: 'Europe/Sofia' } }),
    );
  });

  it('fans out one sms-tenant job per eligible tenant', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenantIds: jest.fn().mockResolvedValue(['a', 'b']), sendForTenant: jest.fn() };
    const p = new SmsReminderProcessor(svc as any, queue as any);
    await p.process({ name: 'sms-daily' } as any);
    expect(queue.add).toHaveBeenCalledWith('sms-tenant', { tenantId: 'a' });
    expect(queue.add).toHaveBeenCalledWith('sms-tenant', { tenantId: 'b' });
  });

  it('runs the per-tenant send for an sms-tenant job', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenantIds: jest.fn(), sendForTenant: jest.fn().mockResolvedValue({ sent: 1 }) };
    const p = new SmsReminderProcessor(svc as any, queue as any);
    await p.process({ name: 'sms-tenant', data: { tenantId: 'a' } } as any);
    expect(svc.sendForTenant).toHaveBeenCalledWith('a');
  });
});
