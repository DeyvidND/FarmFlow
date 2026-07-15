import { Module, forwardRef } from '@nestjs/common';
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
import { VendorFinanceModule } from '../vendor-finance/vendor-finance.module';
import { RoutingModule } from '../routing/routing.module';

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
    VendorFinanceModule,
    // forwardRef: RoutingModule imports this module back (RoutingService needs
    // OrdersService.reschedulable); OrdersController needs RoutingService for
    // the driver own-leg ownership check on findOne/updateStatus.
    forwardRef(() => RoutingModule),
  ],
  controllers: [OrdersController, PublicOrdersController, PublicCheckoutController],
  providers: [OrdersService, CheckoutService],
  exports: [OrdersService],
})
export class OrdersModule {}
