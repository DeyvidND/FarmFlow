import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { SmsReminderService } from './sms-reminder.service';
import { SMS_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';
import { bgNowMinutes } from '../../common/time/bg-time';

@Processor(SMS_QUEUE)
export class SmsReminderProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SmsReminderProcessor.name);

  constructor(
    private readonly reminder: SmsReminderService,
    @InjectQueue(SMS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // Ticks HOURLY (top of every hour, Europe/Sofia); each tick fans out only the
  // tenants whose configured send hour matches — so a per-tenant send time is a
  // pure settings change, no new schedule. Idempotent per worker boot. Windows
  // must be approved by the operator the evening before to have content.
  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'sms-daily', '0 * * * *');
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'sms-daily') {
      const currentHour = Math.floor(bgNowMinutes() / 60);
      const all = await this.reminder.eligibleTenants();
      // Only the tenants whose chosen send hour is THIS hour (default 8).
      const due = all.filter((t) => t.sendHour === currentHour);
      for (const t of due) {
        await this.queue.add('sms-tenant', { tenantId: t.id, channel: t.channel });
      }
      this.logger.log(
        `[reminder] hour ${currentHour}: fanned out ${due.length}/${all.length} tenant reminder job(s)`,
      );
      return;
    }
    if (job.name === 'sms-tenant') {
      const { tenantId, channel } = job.data as {
        tenantId: string;
        channel?: 'email' | 'sms';
      };
      const res = await this.reminder.sendForTenant(tenantId, channel ?? 'email');
      this.logger.log(
        `[reminder] tenant ${tenantId} (${channel ?? 'email'}): ` +
          `sent=${res.sent} skipped=${res.skipped} failed=${res.failed}`,
      );
      return;
    }
    this.logger.warn(`[reminder] unknown job name=${job.name}`);
  }
}
