import { Module } from '@nestjs/common';
import { CarrierFulfillmentService } from './carrier-fulfillment.service';
import { EcontModule } from '../econt/econt.module';
import { SpeedyCoreModule } from '../speedy/speedy-core.module';

/**
 * Thin module that wires {@link CarrierFulfillmentService} with its two carrier
 * dependencies.  Import this wherever `CarrierFulfillmentService` is needed
 * (currently OrdersModule and StripeModule) instead of duplicating the provider.
 */
@Module({
  imports: [EcontModule, SpeedyCoreModule],
  providers: [CarrierFulfillmentService],
  exports: [CarrierFulfillmentService],
})
export class CarrierFulfillmentModule {}
