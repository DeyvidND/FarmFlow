import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OrderProtocolEmailService, ProtocolEmailJobData } from './order-protocol-email.service';
import { PROTOCOL_EMAIL_QUEUE } from '../../common/queue/queue.constants';

// Mirrors EmailProcessor/EMAIL_QUEUE exactly (this codebase's one existing
// email-queue pattern, server/src/common/email/email.processor.ts) — same
// concurrency/limiter shape. Deliberate: a protocol-email job ends up calling
// the SAME pooled SMTP transporter (EmailService.sendMailNow →
// EmailService.deliver) as EMAIL_QUEUE's own jobs, so keeping the two
// processors' rate limits aligned avoids one queue starving the other's share
// of the transporter's maxConnections:3 pool.
@Processor(PROTOCOL_EMAIL_QUEUE, { concurrency: 5, limiter: { max: 10, duration: 1000 } })
export class OrderProtocolEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderProtocolEmailProcessor.name);

  constructor(private readonly orderProtocolEmail: OrderProtocolEmailService) {
    super();
  }

  async process(job: Job<ProtocolEmailJobData>): Promise<void> {
    const { tenantId, orderId } = job.data;
    const result = await this.orderProtocolEmail.sendProtocolEmail(tenantId, orderId);
    if (!result.ok) {
      // Throw so BullMQ applies PROTOCOL_EMAIL_QUEUE's configured retry/backoff
      // (attempts: 5, exponential 2000ms — see the module below). Unlike the
      // human path (Task 6), which has no automatic retry and relies on the
      // user re-clicking confirm, a queued job gets several automatic attempts
      // before it's truly stuck — visible via protocol_email_status='failed'
      // and recoverable via the "прати пак" action (Task 9).
      this.logger.error(`[protocol-email] send failed job=${job.id} order=${orderId}: ${result.error}`);
      throw new Error(result.error);
    }
  }
}
