import { Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { StripeController, StripeConnectController } from './stripe.controller';
import { BillingModule } from '../billing/billing.module';
import { EcontModule } from '../econt/econt.module';
import { OrderEmailModule } from '../order-email/order-email.module';
import { CarrierFulfillmentModule } from '../orders/carrier-fulfillment.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { VendorFinanceModule } from '../vendor-finance/vendor-finance.module';

@Module({
  imports: [
    BillingModule,
    EcontModule,
    OrderEmailModule,
    CarrierFulfillmentModule,
    AnalyticsModule,
    VendorFinanceModule,
    // NB: OrderProtocolEmailModule is @Global — StripeService injects
    // OrderProtocolEmailService without importing it here (importing it closed a
    // bootstrap cycle Stripe → OPE → Handover → Routing → Orders → Stripe).
  ],
  controllers: [StripeController, StripeConnectController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
