import { Module } from '@nestjs/common';
import { HandoverService } from './handover.service';
import { HandoverController } from './handover.controller';

// DrizzleModule is @Global() so DB_TOKEN needs no import here.
@Module({
  controllers: [HandoverController],
  providers: [HandoverService],
})
export class HandoverModule {}
