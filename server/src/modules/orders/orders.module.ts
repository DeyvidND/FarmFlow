import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController, PublicOrdersController } from './orders.controller';
import { CheckoutService } from './checkout.service';
import { PublicCheckoutController } from './checkout.controller';
import { StripeModule } from '../stripe/stripe.module';
import { EcontModule } from '../econt/econt.module';

@Module({
  imports: [StripeModule, EcontModule],
  controllers: [OrdersController, PublicOrdersController, PublicCheckoutController],
  providers: [OrdersService, CheckoutService],
})
export class OrdersModule {}
