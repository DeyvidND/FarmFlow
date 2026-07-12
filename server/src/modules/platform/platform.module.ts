import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { ProductsModule } from '../products/products.module';
import { FarmersModule } from '../farmers/farmers.module';
import { SubcategoriesModule } from '../subcategories/subcategories.module';
import { TenantsModule } from '../tenants/tenants.module';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';
import { VendorFinanceModule } from '../vendor-finance/vendor-finance.module';
import { PlatformMarketplaceFinanceController } from './marketplace-finance.controller';
import { PlatformMarketplaceFinanceService } from './marketplace-finance.service';
import { PlatformService } from './platform.service';
import { PlatformInsightsService } from './insights.service';
import { ProblemsService } from './problems.service';
import { HealthBoardService } from './health-board.service';
import { PlatformController, PlatformAuthController } from './platform.controller';
import { AiImportModule } from '../ai-import/ai-import.module';
import { ProducerOnboardService } from './producer-onboard.service';
import { OperatorDigestService } from './operator-digest.service';
import { OperatorDigestProcessor } from './operator-digest.processor';
import { CriticalAlertService } from './critical-alert.service';
import { CriticalAlertProcessor } from './critical-alert.processor';
import { DemoCleanupProcessor } from './demo-cleanup.processor';
import {
  CLEANUP_QUEUE,
  OPERATOR_DIGEST_QUEUE,
  CRITICAL_ALERT_QUEUE,
  EMAIL_QUEUE,
  ECONT_QUEUE,
  SPEEDY_QUEUE,
  NEWSLETTER_DRAFT_QUEUE,
  IMAGE_QUEUE,
  BILLING_QUEUE,
  ANALYTICS_QUEUE,
} from '../../common/queue/queue.constants';
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
    // Reused dormant commission + vendor-subscription services for the super-admin
    // marketplace-finance oversight controller.
    VendorFinanceModule,
    AiImportModule,
    // Product public-catalog Redis cache (`catalog:{tenantId}`) — busted by
    // setProductFeatured (matches ProductsService's own invalidate-on-write pattern).
    CatalogCacheModule,
    BullModule.registerQueue({
      name: CLEANUP_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
    BullModule.registerQueue({
      name: OPERATOR_DIGEST_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    }),
    BullModule.registerQueue({
      name: CRITICAL_ALERT_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    }),
    // Read-only queue handles for the «Здраве» health board (HealthBoardService) —
    // this module only reads job counts from these, never produces/processes jobs
    // on them (each already has its own owning module elsewhere for that).
    BullModule.registerQueue({ name: EMAIL_QUEUE }),
    BullModule.registerQueue({ name: ECONT_QUEUE }),
    BullModule.registerQueue({ name: SPEEDY_QUEUE }),
    BullModule.registerQueue({ name: NEWSLETTER_DRAFT_QUEUE }),
    BullModule.registerQueue({ name: IMAGE_QUEUE }),
    BullModule.registerQueue({ name: BILLING_QUEUE }),
    BullModule.registerQueue({ name: ANALYTICS_QUEUE }),
  ],
  controllers: [PlatformAuthController, PlatformController, PlatformMarketplaceFinanceController],
  providers: [
    PlatformService,
    PlatformMarketplaceFinanceService,
    PlatformInsightsService,
    ProblemsService,
    HealthBoardService,
    ProducerOnboardService,
    OperatorDigestService,
    CriticalAlertService,
    ...(RUN_WORKERS ? [DemoCleanupProcessor, OperatorDigestProcessor, CriticalAlertProcessor] : []),
  ],
})
export class PlatformModule {}
