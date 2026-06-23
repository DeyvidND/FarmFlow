import { Module } from '@nestjs/common';
import { EcontService } from './econt.service';
import { EcontController, PublicEcontController } from './econt.controller';
import { ShipmentEmailService } from './shipment-email.service';

@Module({
  controllers: [EcontController, PublicEcontController],
  providers: [EcontService, ShipmentEmailService],
  exports: [EcontService, ShipmentEmailService],
})
export class EcontModule {}
