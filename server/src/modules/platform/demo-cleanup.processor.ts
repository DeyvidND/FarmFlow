import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PlatformService } from './platform.service';
import { CLEANUP_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

/** Daily (02:00 Sofia) hard-delete of expired demo tenants. */
@Processor(CLEANUP_QUEUE)
export class DemoCleanupProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DemoCleanupProcessor.name);

  constructor(
    private readonly platform: PlatformService,
    @InjectQueue(CLEANUP_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'expire-demos', '0 2 * * *');
  }

  async process(_job: Job): Promise<void> {
    try {
      const { deleted } = await this.platform.deleteExpiredDemos();
      if (deleted) this.logger.log(`[cleanup] deleted ${deleted} expired demo tenant(s)`);
    } catch (err) {
      this.logger.error(
        `[cleanup] expire-demos failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err; // let BullMQ retry
    }
  }
}
