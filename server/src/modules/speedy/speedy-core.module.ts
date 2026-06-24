import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SpeedyService } from './speedy.service';
import { SpeedyClient } from './speedy.client';
import { SpeedyProcessor } from './speedy.processor';
import { SPEEDY_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
import { CodRiskModule } from '../cod-risk/cod-risk.module';

/**
 * Speedy providers WITHOUT controllers — so the standalone shipping app reuses
 * `SpeedyService` (+ the refresh queue/processor) without mounting any FarmFlow
 * routes. The processor only runs when this process is a worker (RUN_WORKERS).
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
