import { Module } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantsController, PublicTenantController } from './tenants.controller';
import { StripeModule } from '../stripe/stripe.module';

@Module({
  imports: [StripeModule],
  controllers: [TenantsController, PublicTenantController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
