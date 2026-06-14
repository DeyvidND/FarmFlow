import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SlotsService } from './slots.service';
import { SlotsController, PublicSlotsController } from './slots.controller';
import { SlotsProcessor } from './slots.processor';
import { SLOTS_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

@Module({
  imports: [
    BullModule.registerQueue({
      name: SLOTS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [SlotsController, PublicSlotsController],
  providers: [SlotsService, ...(RUN_WORKERS ? [SlotsProcessor] : [])],
})
export class SlotsModule {}
