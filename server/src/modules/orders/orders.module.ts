import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController, PublicOrdersController } from './orders.controller';
import { CheckoutService } from './checkout.service';
import { PublicCheckoutController } from './checkout.controller';
import { CarrierFulfillmentModule } from './carrier-fulfillment.module';
import { StripeModule } from '../stripe/stripe.module';
import { EcontModule } from '../econt/econt.module';
import { SpeedyCoreModule } from '../speedy/speedy-core.module';
import { OrderEmailModule } from '../order-email/order-email.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CodRiskModule } from '../cod-risk/cod-risk.module';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';

@Module({
  imports: [
    StripeModule,
    EcontModule,
    SpeedyCoreModule,
    CarrierFulfillmentModule,
    OrderEmailModule,
    AnalyticsModule,
    CodRiskModule,
    CatalogCacheModule,
  ],
  controllers: [OrdersController, PublicOrdersController, PublicCheckoutController],
  providers: [OrdersService, CheckoutService],
  exports: [OrdersService],
})
export class OrdersModule {}
