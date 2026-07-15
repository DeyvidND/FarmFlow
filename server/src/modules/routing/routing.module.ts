import { Module, forwardRef } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { CourierAccessService } from './courier-access.service';
import { CourierAssignmentService } from './courier-assignment.service';
import { RoutingController } from './routing.controller';
import { OrdersModule } from '../orders/orders.module';
import { OrderEmailModule } from '../order-email/order-email.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // forwardRef: OrdersModule imports this module back (OrdersController needs
  // RoutingService for the driver own-leg ownership check on findOne/updateStatus).
  imports: [forwardRef(() => OrdersModule), OrderEmailModule, AuthModule],
  controllers: [RoutingController],
  providers: [RoutingService, CourierAccessService, CourierAssignmentService],
  // CourierAccessService exported for PlatformModule (Task B1 — super-admin
  // courier-account controller lives there, guarded by PlatformAdminGuard).
  exports: [RoutingService, CourierAssignmentService, CourierAccessService],
})
export class RoutingModule {}
