import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { MustChangePasswordGuard } from './common/guards/must-change-password.guard';
import { envValidationSchema } from './config/env.validation';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { DrizzleModule } from './common/drizzle/drizzle.module';
import { RedisModule } from './common/redis/redis.module';
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
