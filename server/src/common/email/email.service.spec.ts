import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { EmailService } from './email.service';
import { SuppressionService } from './suppression.service';
import { EMAIL_QUEUE } from '../queue/queue.constants';

const cfg = (over: Record<string, any> = {}) => ({
  get: (k: string, d?: any) => (k in over ? over[k] : d),
});

function makeQueue() {
  return { add: jest.fn().mockResolvedValue({ id: 'job1' }) };
}
function makeSuppression(suppressed = false) {
  return { isSuppressed: jest.fn().mockResolvedValue(suppressed) };
}

async function build(queue: any, suppression: any, config = cfg()): Promise<EmailService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      EmailService,
      { provide: ConfigService, useValue: config },
      { provide: SuppressionService, useValue: suppression },
      { provide: getQueueToken(EMAIL_QUEUE), useValue: queue },
    ],
  }).compile();
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const svc = mod.get(EmailService);
  svc.onModuleInit(); // dev mode (no SMTP_HOST) — sets up the preview transport
  return svc;
}

describe('EmailService.sendMail (enqueue)', () => {
  it('enqueues the payload onto the email queue instead of sending inline', async () => {
    const queue = makeQueue();
    const svc = await build(queue, makeSuppression());
    await svc.sendMail({ to: 'a@b.bg', subject: 'Hi', html: '<p>x</p>' });
    expect(queue.add).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({ to: 'a@b.bg', subject: 'Hi', html: '<p>x</p>' }),
    );
  });
});

describe('EmailService.deliver (worker send path)', () => {
  it('skips a suppressed recipient without writing a preview', async () => {
    const svc = await build(makeQueue(), makeSuppression(true));
    const spy = jest.spyOn(svc as any, 'writePreview');
    await svc.deliver({ to: 'bounced@b.bg', subject: 'x', html: 'x' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('delivers (dev preview) a non-suppressed recipient', async () => {
    const svc = await build(makeQueue(), makeSuppression(false));
    const spy = jest.spyOn(svc as any, 'writePreview').mockResolvedValue(undefined);
    await svc.deliver({ to: 'ok@b.bg', subject: 'x', html: '<p>y</p>' });
    expect(spy).toHaveBeenCalled();
  });
});
