import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController, TrackController } from './analytics.controller';
import { AnalyticsRetention } from './analytics.retention';
import { AnalyticsRetentionProcessor } from './analytics-retention.processor';
import { ANALYTICS_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

@Module({
  imports: [
    BullModule.registerQueue({
      name: ANALYTICS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [TrackController, AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsRetention,
    ...(RUN_WORKERS ? [AnalyticsRetentionProcessor] : []),
  ],
})
export class AnalyticsModule {}
