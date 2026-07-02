import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController, TrackController } from './analytics.controller';

@Module({
  controllers: [TrackController, AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
