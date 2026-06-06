import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController, PublicOrdersController } from './orders.controller';
import { CheckoutService } from './checkout.service';
import { PublicCheckoutController } from './checkout.controller';
import { StripeModule } from '../stripe/stripe.module';
import { EcontModule } from '../econt/econt.module';
import { OrderEmailModule } from '../order-email/order-email.module';

@Module({
  imports: [StripeModule, EcontModule, OrderEmailModule],
  controllers: [OrdersController, PublicOrdersController, PublicCheckoutController],
  providers: [OrdersService, CheckoutService],
})
export class OrdersModule {}
