import { Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import {
  StripeController,
  StripeCatalogController,
  StripeConnectController,
} from './stripe.controller';
import { BillingModule } from '../billing/billing.module';
import { EcontModule } from '../econt/econt.module';
import { OrderEmailModule } from '../order-email/order-email.module';

@Module({
  imports: [BillingModule, EcontModule, OrderEmailModule],
  controllers: [StripeController, StripeCatalogController, StripeConnectController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
