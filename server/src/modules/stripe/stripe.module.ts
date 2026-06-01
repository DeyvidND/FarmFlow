import { Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { StripeController, StripeCatalogController } from './stripe.controller';

@Module({
  controllers: [StripeController, StripeCatalogController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
