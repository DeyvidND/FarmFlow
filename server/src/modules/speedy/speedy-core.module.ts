import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SpeedyService } from './speedy.service';
import { SpeedyClient } from './speedy.client';
import { SpeedyProcessor } from './speedy.processor';
import { SPEEDY_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
import { CodRiskModule } from '../cod-risk/cod-risk.module';

/**
 * Speedy providers WITHOUT controllers — mirrors {@link EcontCoreModule}.
 *
 * Imported by both {@link AppModule} (via {@link SpeedyConfigModule}) and the
 * dostavki backend ({@link EcontAppModule}) so each process gets SpeedyService
 * without also mounting the other's controllers.
 *
 * - Main API mounts {@link SpeedyConfigController} via {@link SpeedyConfigModule}.
 * - Dostavki backend mounts {@link SpeedyStandaloneController} directly.
 *
 * The processor only runs when this process is a worker (RUN_WORKERS).
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: SPEEDY_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
    CodRiskModule,
  ],
  providers: [SpeedyService, SpeedyClient, ...(RUN_WORKERS ? [SpeedyProcessor] : [])],
  exports: [SpeedyService, CodRiskModule],
})
export class SpeedyCoreModule {}
