import { Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import {
  StripeController,
  StripeCatalogController,
  StripeConnectController,
} from './stripe.controller';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [BillingModule],
  controllers: [StripeController, StripeCatalogController, StripeConnectController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
