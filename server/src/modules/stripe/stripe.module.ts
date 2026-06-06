import { Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import {
  StripeController,
  StripeCatalogController,
  StripeConnectController,
} from './stripe.controller';
import { BillingModule } from '../billing/billing.module';
import { EcontModule } from '../econt/econt.module';

@Module({
  imports: [BillingModule, EcontModule],
  controllers: [StripeController, StripeCatalogController, StripeConnectController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
