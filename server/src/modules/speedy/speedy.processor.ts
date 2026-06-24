import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { SpeedyService } from './speedy.service';
import { SPEEDY_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(SPEEDY_QUEUE)
export class SpeedyProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SpeedyProcessor.name);

  constructor(
    private readonly speedy: SpeedyService,
    @InjectQueue(SPEEDY_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Every 30 minutes — Speedy statuses move on the order of hours.
    await registerRepeatable(this.queue, 'refresh-active', '*/30 * * * *');
  }

  async process(_job: Job): Promise<void> {
    const { refreshed } = await this.speedy.refreshActiveShipments();
    this.logger.log(`[speedy] refreshed ${refreshed} active shipment(s)`);
  }
}
