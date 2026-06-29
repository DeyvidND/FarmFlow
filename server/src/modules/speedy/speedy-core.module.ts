import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SpeedyService } from './speedy.service';
import { SpeedyClient } from './speedy.client';
import { SpeedyProcessor } from './speedy.processor';
import { SpeedyConfigController } from './speedy-config.controller';
import { SPEEDY_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
import { CodRiskModule } from '../cod-risk/cod-risk.module';

/**
 * Speedy providers + the thin credential-management controller for the main API.
 *
 * `SpeedyConfigController` exposes GET/POST/DELETE on `speedy/config|credentials`
 * so the farmer panel (→ main API) can connect Speedy farmer-scoped without
 * hitting the dostavki-backend process.  All shipment/label routes remain on
 * `SpeedyStandaloneController` which loads only in the dostavki-backend process.
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
  controllers: [SpeedyConfigController],
  providers: [SpeedyService, SpeedyClient, ...(RUN_WORKERS ? [SpeedyProcessor] : [])],
  exports: [SpeedyService, CodRiskModule],
})
export class SpeedyCoreModule {}
