import { Module } from '@nestjs/common';
import { HandoverService } from './handover.service';

// HandoverController lands in a later task (6/10). DrizzleModule is @Global()
// so DB_TOKEN needs no import here.
@Module({
  controllers: [],
  providers: [HandoverService],
})
export class HandoverModule {}
