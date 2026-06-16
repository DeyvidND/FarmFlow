import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { ProductsModule } from '../products/products.module';
import { FarmersModule } from '../farmers/farmers.module';
import { SubcategoriesModule } from '../subcategories/subcategories.module';
import { TenantsModule } from '../tenants/tenants.module';
import { PlatformService } from './platform.service';
import { PlatformInsightsService } from './insights.service';
import { PlatformController, PlatformAuthController } from './platform.controller';

@Module({
  // AuthModule: JwtModule (signing) + jwt strategy; BillingModule: premium toggle.
  // Products/Farmers/Subcategories/Tenants: reused create + site-contact + favicon
  // services for super-admin bulk-import (onboarding seed).
  imports: [AuthModule, BillingModule, ProductsModule, FarmersModule, SubcategoriesModule, TenantsModule],
  controllers: [PlatformAuthController, PlatformController],
  providers: [PlatformService, PlatformInsightsService],
})
export class PlatformModule {}
