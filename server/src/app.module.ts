import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { MulterModule } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import { MustChangePasswordGuard } from './common/guards/must-change-password.guard';
import { TenantRolesGuard } from './common/guards/tenant-roles.guard';
import { envValidationSchema } from './config/env.validation';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { DrizzleModule } from './common/drizzle/drizzle.module';
import { RedisModule } from './common/redis/redis.module';
import { REDIS_TOKEN } from './common/redis/redis.constants';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { throttlerTracker } from './common/throttler/throttler.tracker';
import { EmailModule } from './common/email/email.module';
import { MapsModule } from './common/maps/maps.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { AppController } from './app.controller';
import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { ProductsModule } from './modules/products/products.module';
import { FarmersModule } from './modules/farmers/farmers.module';
import { SubcategoriesModule } from './modules/subcategories/subcategories.module';
import { SlotsModule } from './modules/slots/slots.module';
import { OrdersModule } from './modules/orders/orders.module';
import { RoutingModule } from './modules/routing/routing.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { StatsModule } from './modules/stats/stats.module';
import { PlatformModule } from './modules/platform/platform.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { BillingModule } from './modules/billing/billing.module';
import { IntakeModule } from './modules/intake/intake.module';
import { DemoRequestModule } from './modules/demo-request/demo-request.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { CatalogCacheModule } from './modules/catalog-cache/catalog-cache.module';
import { PublicCacheModule } from './common/cache/public-cache.module';
import { PublicBootstrapModule } from './modules/public-bootstrap/public-bootstrap.module';
import { RecommendationsModule } from './modules/recommendations/recommendations.module';
import { StorageModule } from './modules/storage/storage.module';
import { ArticlesModule } from './modules/articles/articles.module';
import { EcontModule } from './modules/econt/econt.module';
import { SpeedyCoreModule } from './modules/speedy/speedy-core.module';
import { DigestModule } from './modules/digest/digest.module';
import { NewsletterModule } from './modules/newsletter/newsletter.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { QueueModule } from './common/queue/queue.module';
import { HealthModule } from './common/health/health.module';
import { ImageQueueModule } from './modules/image-queue/image-queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../.env', '.env'],
      validationSchema: envValidationSchema,
    }),
    // Distributed rate limiting backed by the shared Redis (REDIS_URL is required),
    // so limits hold across instances and survive restarts. A generous global
    // backstop; abuse-prone routes tighten it via @Throttle, and signature-verified
    // webhooks opt out via @SkipThrottle. Requests are keyed on the JWT principal
    // when authenticated (the panels proxy through a BFF, so IP-keying would
    // collapse all users into one bucket) and on client IP otherwise. Cached public
    // catalog GETs are skipped — the storefront SSRs them from a single IP, and
    // volumetric DDoS there is an edge/CDN concern (see docs/SECURITY.md).
    ThrottlerModule.forRootAsync({
      inject: [REDIS_TOKEN, ConfigService],
      useFactory: (redis: Redis, config: ConfigService) => {
        const disabled = config.get<string>('RATE_LIMIT_DISABLED') === 'true';
        return {
          throttlers: [
            {
              name: 'default',
              ttl: config.get<number>('RATE_LIMIT_TTL_MS', 60_000),
              limit: config.get<number>('RATE_LIMIT_DEFAULT', 300),
            },
          ],
          storage: new RedisThrottlerStorage(redis),
          getTracker: (req) => throttlerTracker(req as any),
          skipIf: (ctx) => {
            if (disabled) return true;
            const req = ctx.switchToHttp().getRequest();
            // Cached, anonymous catalog reads SSR'd from one IP — don't throttle.
            return req.method === 'GET' && typeof req.path === 'string' && req.path.startsWith('/public/');
          },
        };
      },
    }),
    // Cap multipart upload size + count globally. Multer enforces this at the
    // stream level BEFORE the per-route MaxFileSizeValidator runs, so the global
    // ceiling must be >= the largest route limit (article video = 50 MB) or those
    // uploads are truncated/rejected before their own validator is reached. The
    // tighter per-route image limit (5 MB) still applies via the route validators.
    MulterModule.register({
      limits: {
        fileSize: Number(process.env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
        files: 1,
      },
    }),
    DrizzleModule,
    RedisModule,
    QueueModule,
    HealthModule,
    EmailModule,
    MapsModule,
    AuthModule,
    TenantsModule,
    ProductsModule,
    FarmersModule,
    SubcategoriesModule,
    SlotsModule,
    // RoutingModule before OrdersModule so `/orders/route` registers before `/orders/:id`.
    RoutingModule,
    OrdersModule,
    DashboardModule,
    StatsModule,
    PlatformModule,
    StripeModule,
    BillingModule,
    IntakeModule,
    DemoRequestModule,
    ReviewsModule,
    CatalogCacheModule,
    PublicCacheModule,
    StorageModule,
    ArticlesModule,
    EcontModule,
    SpeedyCoreModule, // Speedy refresh cron runs in the worker process; no controllers here.
    DigestModule,
    NewsletterModule,
    AvailabilityModule,
    // After the feature modules it composes (Tenants/Products/Farmers/Subcategories).
    PublicBootstrapModule,
    RecommendationsModule,
    ImageQueueModule,
  ],
  controllers: [AppController],
  providers: [
    // First global guard: reject floods before any auth/DB work runs.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: MustChangePasswordGuard,
    },
    {
      // Default-deny role enforcement for tenant tokens (admin-only unless a
      // @Roles decorator opens the route). No-op today; future-proofs driver/customer.
      provide: APP_GUARD,
      useClass: TenantRolesGuard,
    },
  ],
})
export class AppModule {}
