import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { EmailService } from './email.service';
import { SuppressionService } from './suppression.service';
import { EMAIL_QUEUE } from '../queue/queue.constants';
import { PROTOCOL_ATTACHMENT_RESOLVER } from './protocol-attachment.types';

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

  it('skips the suppression lookup when skipSuppressionCheck is true', async () => {
    const suppression = makeSuppression(false);
    const svc = await build(makeQueue(), suppression);
    jest.spyOn(svc as any, 'writePreview').mockResolvedValue(undefined);
    await svc.deliver({ to: 'x@b.bg', subject: 'x', html: 'x', skipSuppressionCheck: true });
    expect(suppression.isSuppressed).not.toHaveBeenCalled();
  });
});

describe('EmailService.sendMailNow (direct, no queue)', () => {
  it('calls deliver() directly and never touches the queue', async () => {
    const queue = makeQueue();
    const svc = await build(queue, makeSuppression(false));
    jest.spyOn(svc as any, 'writePreview').mockResolvedValue(undefined);

    await svc.sendMailNow({ to: 'a@b.bg', subject: 'Hi', html: '<p>x</p>' });

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('propagates a delivery failure to the caller (no swallow, no retry)', async () => {
    const svc = await build(makeQueue(), makeSuppression(false));
    jest.spyOn(svc as any, 'writePreview').mockRejectedValue(new Error('disk full'));

    await expect(
      svc.sendMailNow({ to: 'a@b.bg', subject: 'Hi', html: '<p>x</p>' }),
    ).rejects.toThrow('disk full');
  });
});

describe('EmailService attachment materialization', () => {
  it('resolves a handover-protocol attachment via the injected resolver before delivering', async () => {
    const resolver = {
      resolve: jest.fn().mockResolvedValue({ filename: 'protocol-7.pdf', content: Buffer.from('%PDF-1.4 fake') }),
    };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: ConfigService, useValue: cfg() },
        { provide: SuppressionService, useValue: makeSuppression(false) },
        { provide: getQueueToken(EMAIL_QUEUE), useValue: makeQueue() },
        { provide: PROTOCOL_ATTACHMENT_RESOLVER, useValue: resolver },
      ],
    }).compile();
    const svc = mod.get(EmailService);
    svc.onModuleInit();
    const previewSpy = jest.spyOn(svc as any, 'writePreview').mockResolvedValue(undefined);

    await svc.deliver({
      to: 'a@b.bg',
      subject: 'Протокол',
      html: '<p>x</p>',
      attachments: [{ kind: 'handover-protocol', protocolId: 'p1', tenantId: 't1' }],
    });

    expect(resolver.resolve).toHaveBeenCalledWith({ kind: 'handover-protocol', protocolId: 'p1', tenantId: 't1' });
    // The ACTUAL bytes reached writePreview's options — not a boolean, the real content.
    const opts = previewSpy.mock.calls[0][0] as any;
    expect(opts.attachments[0].content).toEqual(Buffer.from('%PDF-1.4 fake'));
    expect(opts.attachments[0].filename).toBe('protocol-7.pdf');
  });

  it('throws a clear error if attachments are requested but no resolver is wired', async () => {
    const svc = await build(makeQueue(), makeSuppression(false)); // no resolver provided
    await expect(
      svc.deliver({
        to: 'a@b.bg', subject: 'x', html: 'x',
        attachments: [{ kind: 'handover-protocol', protocolId: 'p1', tenantId: 't1' }],
      }),
    ).rejects.toThrow(/attachment resolver/i);
  });
});
