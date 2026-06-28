import { Module } from '@nestjs/common';
import { CarrierFulfillmentService } from './carrier-fulfillment.service';
import { CarrierRegistry } from './carrier-registry';
import { EcontModule } from '../econt/econt.module';
import { SpeedyCoreModule } from '../speedy/speedy-core.module';

/**
 * Thin module that wires {@link CarrierFulfillmentService} + the {@link
 * CarrierRegistry} with their two carrier dependencies.  Import this wherever
 * `CarrierFulfillmentService` is needed (currently OrdersModule and StripeModule)
 * instead of duplicating the provider. CarrierRegistry is exported too so the
 * generic carrier controller can resolve adapters by name.
 */
@Module({
  imports: [EcontModule, SpeedyCoreModule],
  providers: [CarrierFulfillmentService, CarrierRegistry],
  exports: [CarrierFulfillmentService, CarrierRegistry],
})
export class CarrierFulfillmentModule {}
