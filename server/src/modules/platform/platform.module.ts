import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { ProductsModule } from '../products/products.module';
import { FarmersModule } from '../farmers/farmers.module';
import { SubcategoriesModule } from '../subcategories/subcategories.module';
import { TenantsModule } from '../tenants/tenants.module';
import { PlatformService } from './platform.service';
import { PlatformInsightsService } from './insights.service';
import { PlatformController, PlatformAuthController } from './platform.controller';
import { DemoCleanupProcessor } from './demo-cleanup.processor';
import { CLEANUP_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

@Module({
  // AuthModule: JwtModule (signing) + jwt strategy; BillingModule: premium toggle.
  // Products/Farmers/Subcategories/Tenants: reused create + site-contact + favicon
  // services for super-admin bulk-import (onboarding seed).
  imports: [
    AuthModule,
    BillingModule,
    ProductsModule,
    FarmersModule,
    SubcategoriesModule,
    TenantsModule,
    BullModule.registerQueue({
      name: CLEANUP_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [PlatformAuthController, PlatformController],
  providers: [
    PlatformService,
    PlatformInsightsService,
    ...(RUN_WORKERS ? [DemoCleanupProcessor] : []),
  ],
})
export class PlatformModule {}
