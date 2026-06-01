import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController, PublicOrdersController } from './orders.controller';
import { CheckoutService } from './checkout.service';
import { PublicCheckoutController } from './checkout.controller';
import { StripeModule } from '../stripe/stripe.module';

@Module({
  imports: [StripeModule],
  controllers: [OrdersController, PublicOrdersController, PublicCheckoutController],
  providers: [OrdersService, CheckoutService],
})
export class OrdersModule {}
