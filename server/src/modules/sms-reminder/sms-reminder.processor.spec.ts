import { SmsReminderProcessor } from './sms-reminder.processor';
import { bgNowMinutes } from '../../common/time/bg-time';

describe('SmsReminderProcessor', () => {
  function makeQueue() {
    const added: any[] = [];
    return {
      added,
      add: jest.fn(async (name, data, opts) => {
        added.push({ name, data, opts });
      }),
      // registerRepeatable clears stale schedulers before adding.
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeJobScheduler: jest.fn(),
    };
  }

  // The hour the processor will compute this tick (same clock as the SUT).
  const nowHour = () => Math.floor(bgNowMinutes() / 60);

  it('registers the HOURLY Europe/Sofia repeatable on boot', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenants: jest.fn(), sendForTenant: jest.fn() };
    const p = new SmsReminderProcessor(svc as any, queue as any);
    await p.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      'sms-daily', {},
      expect.objectContaining({ repeat: { pattern: '0 * * * *', tz: 'Europe/Sofia' } }),
    );
  });

  it('fans out only the tenants whose sendHour is the current hour, carrying channel', async () => {
    const queue = makeQueue();
    const hour = nowHour();
    const svc = {
      eligibleTenants: jest.fn().mockResolvedValue([
        { id: 'a', channel: 'email', sendHour: hour }, // due now
        { id: 'b', channel: 'sms', sendHour: (hour + 1) % 24 }, // not this hour
        { id: 'c', channel: 'email', sendHour: hour }, // due now
      ]),
      sendForTenant: jest.fn(),
    };
    const p = new SmsReminderProcessor(svc as any, queue as any);
    await p.process({ name: 'sms-daily' } as any);

    const fanned = queue.added.filter((j) => j.name === 'sms-tenant');
    expect(fanned).toHaveLength(2);
    expect(queue.add).toHaveBeenCalledWith('sms-tenant', { tenantId: 'a', channel: 'email' });
    expect(queue.add).toHaveBeenCalledWith('sms-tenant', { tenantId: 'c', channel: 'email' });
    expect(queue.add).not.toHaveBeenCalledWith('sms-tenant', { tenantId: 'b', channel: 'sms' });
  });

  it('fans out nothing when no tenant is due this hour', async () => {
    const queue = makeQueue();
    const hour = nowHour();
    const svc = {
      eligibleTenants: jest.fn().mockResolvedValue([
        { id: 'a', channel: 'email', sendHour: (hour + 3) % 24 },
      ]),
      sendForTenant: jest.fn(),
    };
    const p = new SmsReminderProcessor(svc as any, queue as any);
    await p.process({ name: 'sms-daily' } as any);
    expect(queue.added.filter((j) => j.name === 'sms-tenant')).toHaveLength(0);
  });

  it('runs the per-tenant send with the carried channel for an sms-tenant job', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenants: jest.fn(), sendForTenant: jest.fn().mockResolvedValue({ sent: 1 }) };
    const p = new SmsReminderProcessor(svc as any, queue as any);
    await p.process({ name: 'sms-tenant', data: { tenantId: 'a', channel: 'sms' } } as any);
    expect(svc.sendForTenant).toHaveBeenCalledWith('a', 'sms');
  });
});
