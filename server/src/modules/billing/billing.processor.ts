import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { BillingService } from './billing.service';
import { BILLING_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(BILLING_QUEUE)
export class BillingProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly billing: BillingService,
    @InjectQueue(BILLING_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'suspend-grace', '0 3 * * *');
  }

  async process(_job: Job): Promise<void> {
    await this.billing.suspendExpiredGrace();
  }
}
