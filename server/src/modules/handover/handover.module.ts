import { Module } from '@nestjs/common';
import { HandoverService } from './handover.service';
import { HandoverController } from './handover.controller';
import { RoutingModule } from '../routing/routing.module';

// DrizzleModule is @Global() so DB_TOKEN needs no import here.
//
// RoutingModule supplies RoutingService + CourierAssignmentService, which
// `GET /handover/check` needs to scope a driver to their own route leg.
//
// HandoverService is now exported (Phase 2, 2026-07-22): the new
// OrderProtocolEmailModule needs it (via its
// HandoverProtocolAttachmentResolver) to render the customer's bilateral
// protocol for email. That module imports HandoverModule with forwardRef() on
// its side — see order-protocol-email.module.ts for why.
@Module({
  imports: [RoutingModule],
  controllers: [HandoverController],
  providers: [HandoverService],
  exports: [HandoverService],
})
export class HandoverModule {}
