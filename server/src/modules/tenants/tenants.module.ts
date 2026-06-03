import { Module } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantsController, PublicTenantController } from './tenants.controller';

@Module({
  controllers: [TenantsController, PublicTenantController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
