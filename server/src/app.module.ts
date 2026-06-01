import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { envValidationSchema } from './config/env.validation';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { DrizzleModule } from './common/drizzle/drizzle.module';
import { RedisModule } from './common/redis/redis.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { AppController } from './app.controller';
import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { ProductsModule } from './modules/products/products.module';
import { SlotsModule } from './modules/slots/slots.module';
import { OrdersModule } from './modules/orders/orders.module';
import { RoutingModule } from './modules/routing/routing.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { PlatformModule } from './modules/platform/platform.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { IntakeModule } from './modules/intake/intake.module';
import { CatalogCacheModule } from './modules/catalog-cache/catalog-cache.module';
import { StorageModule } from './modules/storage/storage.module';
import { ArticlesModule } from './modules/articles/articles.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../.env', '.env'],
      validationSchema: envValidationSchema,
    }),
    DrizzleModule,
    RedisModule,
    AuthModule,
    TenantsModule,
    ProductsModule,
    SlotsModule,
    // RoutingModule before OrdersModule so `/orders/route` registers before `/orders/:id`.
    RoutingModule,
    OrdersModule,
    DashboardModule,
    PlatformModule,
    StripeModule,
    IntakeModule,
    CatalogCacheModule,
    StorageModule,
    ArticlesModule,
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
  ],
})
export class AppModule {}
