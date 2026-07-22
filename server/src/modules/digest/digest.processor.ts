import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { DigestService } from './digest.service';
import { DIGEST_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';
import { bgToday } from '../../common/time/bg-time';

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
  // Task #14: also register an 18:00 repeatable that emails each farmer TOMORROW's
  // confirmed orders, so they know the next day's prep before end of day.
  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'daily', '0 7 * * *');
    await registerRepeatable(this.queue, 'tomorrow', '0 18 * * *');
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'daily') {
      const ids = await this.digest.eligibleTenantIds();
      // Deterministic jobId (per tenant, per BG calendar day) so a mid-loop
      // parent-job retry (attempts: 3) re-fanning this loop dedups against
      // already-enqueued/child jobs instead of double-sending digests. The
      // retention override keeps the id reserved across the retry window —
      // the queue default is removeOnComplete: true, which would otherwise
      // free up the id (and re-add a duplicate) as soon as a child finishes.
      const ymd = bgToday().replace(/-/g, '');
      for (const tenantId of ids) {
        await this.queue.add(
          'tenant',
          { tenantId },
          { jobId: `digest-tenant-${tenantId}-${ymd}`, removeOnComplete: { age: 86400 } },
        );
      }
      this.logger.log(`[digest] fanned out ${ids.length} tenant job(s)`);
      return;
    }
    if (job.name === 'tenant') {
      await this.digest.runForTenant((job.data as { tenantId: string }).tenantId);
      return;
    }
    // Task #14: 18:00 fan-out — every tenant (not just multi-farmer/has-email
    // ones, see allTenantIds), one job per tenant so a single failure doesn't
    // block the rest.
    if (job.name === 'tomorrow') {
      const ids = await this.digest.allTenantIds();
      // Same deterministic-jobId dedup as the 'daily' fan-out above.
      const ymd = bgToday().replace(/-/g, '');
      for (const tenantId of ids) {
        await this.queue.add(
          'tenant-tomorrow',
          { tenantId },
          { jobId: `digest-tomorrow-${tenantId}-${ymd}`, removeOnComplete: { age: 86400 } },
        );
      }
      this.logger.log(`[digest] fanned out ${ids.length} tomorrow-email tenant job(s)`);
      return;
    }
    if (job.name === 'tenant-tomorrow') {
      await this.digest.runTomorrowForTenant((job.data as { tenantId: string }).tenantId);
      return;
    }
    this.logger.warn(`[digest] unknown job name=${job.name}`);
  }
}
