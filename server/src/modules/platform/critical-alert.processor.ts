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

  // Register the every-15-minutes repeatable once on worker boot (idempotent).
  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'check', '*/15 * * * *');
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
