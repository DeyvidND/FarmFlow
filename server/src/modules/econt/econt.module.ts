import { Module } from '@nestjs/common';
import { EcontCoreModule } from './econt-core.module';
import { EcontController, PublicEcontController } from './econt.controller';

/**
 * Full FarmFlow Econt module: the controller-less {@link EcontCoreModule} plus the
 * admin + public storefront controllers. Re-exports EcontCoreModule so existing
 * consumers (Stripe, Orders) keep getting `EcontService` / `ShipmentEmailService`.
 */
@Module({
  imports: [EcontCoreModule],
  controllers: [EcontController, PublicEcontController],
  exports: [EcontCoreModule],
})
export class EcontModule {}
