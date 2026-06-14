import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { SlotsService } from './slots.service';
import { SLOTS_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(SLOTS_QUEUE)
export class SlotsProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly slots: SlotsService,
    @InjectQueue(SLOTS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'materialize', '30 6 * * *');
  }

  async process(_job: Job): Promise<void> {
    await this.slots.materializeAllRules();
  }
}
