import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailService, SendMailOptions } from './email.service';
import { EMAIL_QUEUE } from '../queue/queue.constants';

// Concurrency + rate limit sized to stay inside the Resend plan: a newsletter or
// the daily digest fan-out can enqueue a burst; the limiter smooths the send rate.
@Processor(EMAIL_QUEUE, { concurrency: 5, limiter: { max: 10, duration: 1000 } })
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly email: EmailService) {
    super();
  }

  async process(job: Job<SendMailOptions>): Promise<void> {
    try {
      await this.email.deliver(job.data);
    } catch (err) {
      this.logger.error(
        `[email] send failed job=${job.id} to=${job.data.to}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err; // let BullMQ apply its retry/backoff
    }
  }
}
