import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { NewsletterDraftService } from './newsletter-draft.service';
import { NEWSLETTER_DRAFT_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(NEWSLETTER_DRAFT_QUEUE)
export class NewsletterDraftProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(NewsletterDraftProcessor.name);

  constructor(
    private readonly drafts: NewsletterDraftService,
    @InjectQueue(NEWSLETTER_DRAFT_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // Thursday 08:00 Europe/Sofia, registered once on worker boot (idempotent).
  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'weekly', '0 8 * * 4');
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'weekly') {
      const ids = await this.drafts.eligibleTenantIds();
      for (const tenantId of ids) await this.queue.add('tenant', { tenantId });
      this.logger.log(`[newsletter-draft] fanned out ${ids.length} tenant job(s)`);
      return;
    }
    if (job.name === 'tenant') {
      const res = await this.drafts.generateForTenant((job.data as { tenantId: string }).tenantId);
      this.logger.log(`[newsletter-draft] ${JSON.stringify(res)}`);
      return;
    }
    this.logger.warn(`[newsletter-draft] unknown job name=${job.name}`);
  }
}
