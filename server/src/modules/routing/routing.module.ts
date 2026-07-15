import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { CourierAccessService } from './courier-access.service';
import { RoutingController } from './routing.controller';
import { OrdersModule } from '../orders/orders.module';
import { OrderEmailModule } from '../order-email/order-email.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [OrdersModule, OrderEmailModule, AuthModule],
  controllers: [RoutingController],
  providers: [RoutingService, CourierAccessService],
})
export class RoutingModule {}
