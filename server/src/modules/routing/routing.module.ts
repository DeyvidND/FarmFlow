import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { RoutingController } from './routing.controller';
import { OrdersModule } from '../orders/orders.module';
import { OrderEmailModule } from '../order-email/order-email.module';

@Module({
  imports: [OrdersModule, OrderEmailModule],
  controllers: [RoutingController],
  providers: [RoutingService],
})
export class RoutingModule {}
