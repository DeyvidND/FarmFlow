import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { OperatorDigestService } from './operator-digest.service';
import { OPERATOR_DIGEST_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(OPERATOR_DIGEST_QUEUE)
export class OperatorDigestProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(OperatorDigestProcessor.name);

  constructor(
    private readonly digest: OperatorDigestService,
    @InjectQueue(OPERATOR_DIGEST_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // Register the 07:00 Europe/Sofia repeatable once on worker boot (idempotent).
  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'daily', '0 7 * * *');
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'daily') {
      const res = await this.digest.runDaily();
      this.logger.log(`[operator-digest] daily run → ${JSON.stringify(res)}`);
      return;
    }
    this.logger.warn(`[operator-digest] unknown job name=${job.name}`);
  }
}
