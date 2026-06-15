import { Module } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantsController, PublicTenantController } from './tenants.controller';
import { SiteEditController } from './site-edit.controller';
import { EditSessionGuard } from '../../common/guards/edit-session.guard';
import { StripeModule } from '../stripe/stripe.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [StripeModule, AuthModule],
  controllers: [TenantsController, PublicTenantController, SiteEditController],
  providers: [TenantsService, EditSessionGuard],
  exports: [TenantsService],
})
export class TenantsModule {}
