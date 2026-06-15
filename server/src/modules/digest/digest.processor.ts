import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { DigestService } from './digest.service';
import { DIGEST_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(DIGEST_QUEUE)
export class DigestProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DigestProcessor.name);

  constructor(
    private readonly digest: DigestService,
    @InjectQueue(DIGEST_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // Register the 07:00 Europe/Sofia repeatable once on worker boot (idempotent).
  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'daily', '0 7 * * *');
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'daily') {
      const ids = await this.digest.eligibleTenantIds();
      for (const tenantId of ids) {
        await this.queue.add('tenant', { tenantId });
      }
      this.logger.log(`[digest] fanned out ${ids.length} tenant job(s)`);
      return;
    }
    if (job.name === 'tenant') {
      await this.digest.runForTenant((job.data as { tenantId: string }).tenantId);
      return;
    }
    this.logger.warn(`[digest] unknown job name=${job.name}`);
  }
}
