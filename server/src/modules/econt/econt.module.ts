import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EcontService } from './econt.service';
import { EcontController, PublicEcontController } from './econt.controller';
import { EcontProcessor } from './econt.processor';
import { ShipmentEmailService } from './shipment-email.service';
import { ECONT_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

@Module({
  imports: [
    BullModule.registerQueue({
      name: ECONT_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [EcontController, PublicEcontController],
  providers: [EcontService, ShipmentEmailService, ...(RUN_WORKERS ? [EcontProcessor] : [])],
  exports: [EcontService, ShipmentEmailService],
})
export class EcontModule {}
