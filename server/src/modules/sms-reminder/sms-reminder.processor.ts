import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { SmsReminderService } from './sms-reminder.service';
import { SMS_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(SMS_QUEUE)
export class SmsReminderProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SmsReminderProcessor.name);

  constructor(
    private readonly reminder: SmsReminderService,
    @InjectQueue(SMS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // 08:00 Europe/Sofia, once per worker boot (idempotent). Windows must be
  // approved by the operator the evening before for the send to have content.
  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'sms-daily', '0 8 * * *');
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'sms-daily') {
      const ids = await this.reminder.eligibleTenantIds();
      for (const tenantId of ids) {
        await this.queue.add('sms-tenant', { tenantId });
      }
      this.logger.log(`[sms] fanned out ${ids.length} tenant reminder job(s)`);
      return;
    }
    if (job.name === 'sms-tenant') {
      const res = await this.reminder.sendForTenant((job.data as { tenantId: string }).tenantId);
      this.logger.log(
        `[sms] tenant ${(job.data as { tenantId: string }).tenantId}: ` +
          `sent=${res.sent} skipped=${res.skipped} failed=${res.failed}`,
      );
      return;
    }
    this.logger.warn(`[sms] unknown job name=${job.name}`);
  }
}
