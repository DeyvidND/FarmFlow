import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { MulterModule } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import { MustChangePasswordGuard } from './common/guards/must-change-password.guard';
import { envValidationSchema } from './config/env.validation';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { DrizzleModule } from './common/drizzle/drizzle.module';
import { RedisModule } from './common/redis/redis.module';
import { REDIS_TOKEN } from './common/redis/redis.constants';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
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
import { PlatformModule } from './modules/platform/platform.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { IntakeModule } from './modules/intake/intake.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { CatalogCacheModule } from './modules/catalog-cache/catalog-cache.module';
import { PublicCacheModule } from './common/cache/public-cache.module';
import { PublicBootstrapModule } from './modules/public-bootstrap/public-bootstrap.module';
import { StorageModule } from './modules/storage/storage.module';
import { ArticlesModule } from './modules/articles/articles.module';
import { EcontModule } from './modules/econt/econt.module';
import { DigestModule } from './modules/digest/digest.module';
import { NewsletterModule } from './modules/newsletter/newsletter.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../.env', '.env'],
      validationSchema: envValidationSchema,
    }),
    ScheduleModule.forRoot(),
    // Distributed rate limiting backed by the shared Redis (REDIS_URL is required),
    // so limits hold across instances and survive restarts. A generous global
    // backstop (per client IP); abuse-prone routes tighten it via @Throttle, and
    // signature-verified webhooks opt out via @SkipThrottle. Volumetric DDoS on the
    // cached public catalog is an edge/CDN concern — see docs/SECURITY.md.
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
          skipIf: () => disabled,
        };
      },
    }),
    // Cap multipart upload size + count globally. Inline `FileInterceptor('image')`
    // calls inherit these limits (none of them override), so a single oversized
    // upload can't exhaust memory/disk.
    MulterModule.register({
      limits: {
        fileSize: Number(process.env.MAX_UPLOAD_MB ?? 8) * 1024 * 1024,
        files: 1,
      },
    }),
    DrizzleModule,
    RedisModule,
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
    PlatformModule,
    StripeModule,
    IntakeModule,
    ReviewsModule,
    CatalogCacheModule,
    PublicCacheModule,
    StorageModule,
    ArticlesModule,
    EcontModule,
    DigestModule,
    NewsletterModule,
    // After the feature modules it composes (Tenants/Products/Farmers/Subcategories).
    PublicBootstrapModule,
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
  ],
})
export class AppModule {}
