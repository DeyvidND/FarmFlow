import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { EcontService } from './econt.service';
import { ECONT_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(ECONT_QUEUE)
export class EcontProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(EcontProcessor.name);

  constructor(
    private readonly econt: EcontService,
    @InjectQueue(ECONT_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Every 30 minutes — Econt statuses move on the order of hours.
    await registerRepeatable(this.queue, 'refresh-active', '*/30 * * * *');
  }

  async process(_job: Job): Promise<void> {
    const { refreshed } = await this.econt.refreshActiveShipments();
    this.logger.log(`[econt] refreshed ${refreshed} active shipment(s)`);
  }
}
