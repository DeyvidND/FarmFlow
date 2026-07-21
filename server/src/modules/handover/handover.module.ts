import { Module } from '@nestjs/common';
import { HandoverService } from './handover.service';
import { HandoverController } from './handover.controller';
import { RoutingModule } from '../routing/routing.module';

// DrizzleModule is @Global() so DB_TOKEN needs no import here.
//
// RoutingModule supplies RoutingService + CourierAssignmentService, which
// `GET /handover/check` needs to scope a driver to their own route leg. No
// forwardRef needed: nothing imports HandoverModule except AppModule, so this
// edge introduces no cycle.
@Module({
  imports: [RoutingModule],
  controllers: [HandoverController],
  providers: [HandoverService],
})
export class HandoverModule {}
