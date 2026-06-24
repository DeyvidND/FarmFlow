import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EcontService } from './econt.service';
import { EcontProcessor } from './econt.processor';
import { ShipmentEmailService } from './shipment-email.service';
import { ECONT_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

/**
 * Econt providers WITHOUT the controllers — so the standalone Econt app can reuse
 * `EcontService` (+ ShipmentEmailService + the refresh queue/processor) without
 * also mounting the FarmFlow admin `/econt/*` + public office-picker controllers.
 * `EcontModule` adds those controllers on top of this.
 */
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
  providers: [EcontService, ShipmentEmailService, ...(RUN_WORKERS ? [EcontProcessor] : [])],
  exports: [EcontService, ShipmentEmailService],
})
export class EcontCoreModule {}
