import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { CriticalAlertService } from './critical-alert.service';
import { CRITICAL_ALERT_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(CRITICAL_ALERT_QUEUE)
export class CriticalAlertProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(CriticalAlertProcessor.name);

  constructor(
    private readonly alert: CriticalAlertService,
    @InjectQueue(CRITICAL_ALERT_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // Register the twice-daily (07:00 + 19:00 Europe/Sofia) repeatable once on worker
  // boot (idempotent).
  async onModuleInit(): Promise<void> {
    // Best-effort: drop the stale every-15-minutes schedule from older deploys so
    // they self-heal onto the new cadence. Safe no-op if it was never registered.
    try {
      await this.queue.removeRepeatable('check', { pattern: '*/15 * * * *', tz: 'Europe/Sofia' }, 'check');
    } catch {
      /* no-op if absent */
    }
    await registerRepeatable(this.queue, 'check', '0 7,19 * * *');
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'check') {
      const res = await this.alert.checkAndAlert();
      this.logger.log(`[critical-alert] check run → ${JSON.stringify(res)}`);
      return;
    }
    this.logger.warn(`[critical-alert] unknown job name=${job.name}`);
  }
}
