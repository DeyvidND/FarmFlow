import { Module } from '@nestjs/common';
import { HandoverService } from './handover.service';
import { HandoverController } from './handover.controller';
import { ConsolidatedProtocolService } from './consolidated-protocol.service';
import { ConsolidatedProtocolController } from './consolidated-protocol.controller';
import { RoutingModule } from '../routing/routing.module';

// DrizzleModule is @Global() so DB_TOKEN needs no import here.
//
// RoutingModule supplies RoutingService + CourierAssignmentService, which
// `GET /handover/check` needs to scope a driver to their own route leg. No
// forwardRef needed here: nothing imports HandoverModule except AppModule and —
// with forwardRef() on ITS side — OrderProtocolEmailModule, so this edge
// introduces no cycle. ConsolidatedProtocolService/Controller (the обобщен
// приемо-предавателен протокол — day/leg consolidated handover, see
// consolidated-protocol.service.ts) share the same RoutingModule dependency.
//
// HandoverService is exported (Phase 2, 2026-07-22): OrderProtocolEmailModule
// needs it (via its HandoverProtocolAttachmentResolver) to render the
// customer's bilateral protocol for email — see order-protocol-email.module.ts.
@Module({
  imports: [RoutingModule],
  controllers: [HandoverController, ConsolidatedProtocolController],
  providers: [HandoverService, ConsolidatedProtocolService],
  exports: [HandoverService],
})
export class HandoverModule {}
