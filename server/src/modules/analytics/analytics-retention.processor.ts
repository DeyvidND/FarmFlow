import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { AnalyticsRetention } from './analytics.retention';
import { ANALYTICS_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

/** Nightly (03:00 Sofia) prune of site_events older than the retention window. */
@Processor(ANALYTICS_QUEUE)
export class AnalyticsRetentionProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsRetentionProcessor.name);

  constructor(
    private readonly retention: AnalyticsRetention,
    @InjectQueue(ANALYTICS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'prune', '0 3 * * *');
  }

  async process(_job: Job): Promise<void> {
    try {
      await this.retention.prune();
    } catch (err) {
      this.logger.error(
        `[analytics] prune failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err; // let BullMQ retry
    }
  }
}
