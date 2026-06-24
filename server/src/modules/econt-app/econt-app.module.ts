import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { DrizzleModule } from '../../common/drizzle/drizzle.module';
import { RedisModule } from '../../common/redis/redis.module';
import { REDIS_TOKEN } from '../../common/redis/redis.constants';
import { RedisThrottlerStorage } from '../../common/throttler/redis-throttler.storage';
import { throttlerTracker } from '../../common/throttler/throttler.tracker';
import { QueueModule } from '../../common/queue/queue.module';
import { EmailModule } from '../../common/email/email.module';
import { PublicCacheModule } from '../../common/cache/public-cache.module';
import { MustChangePasswordGuard } from '../../common/guards/must-change-password.guard';
import { TenantRolesGuard } from '../../common/guards/tenant-roles.guard';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
// Controller-less core modules: reuse AuthService + EcontService WITHOUT mounting
// FarmFlow's `/auth/*` and `/econt/*` controllers on the standalone domain.
import { AuthCoreModule } from '../auth/auth-core.module';
import { EcontCoreModule } from '../econt/econt-core.module';
import { SpeedyCoreModule } from '../speedy/speedy-core.module';
import { StandaloneAuthService } from './standalone-auth.service';
import { StandaloneAuthController } from './standalone-auth.controller';
import { EcontStandaloneController } from './econt-standalone.controller';
import { SpeedyStandaloneController } from '../speedy/speedy-standalone.controller';
import { ActivationGuard } from './activation.guard';
import { ShippingQuoteService } from './shipping-quote.service';
import { ShippingQuoteController } from './shipping-quote.controller';
import { ImportModule } from '../import/import.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    ThrottlerModule.forRootAsync({
      inject: [REDIS_TOKEN, ConfigService],
      useFactory: (redis: Redis, config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('RATE_LIMIT_TTL_MS', 60_000),
            limit: config.get<number>('RATE_LIMIT_DEFAULT', 300),
          },
        ],
        storage: new RedisThrottlerStorage(redis),
        getTracker: (req) => throttlerTracker(req as any),
      }),
    }),
    DrizzleModule,
    RedisModule,
    QueueModule,
    EmailModule,
    PublicCacheModule,
    AuthCoreModule, // JwtModule + JwtStrategy + AuthService (no /auth/* controller)
    EcontCoreModule, // EcontService + ShipmentEmailService (no /econt/* controllers)
    SpeedyCoreModule, // SpeedyService + refresh queue/processor (no /speedy/* controllers)
    ImportModule,
  ],
  controllers: [StandaloneAuthController, EcontStandaloneController, SpeedyStandaloneController, ShippingQuoteController],
  providers: [
    StandaloneAuthService,
    ActivationGuard,
    ShippingQuoteService,
    // Flood protection first.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Same default-deny + force-change-password posture as the main API, so the
    // standalone surface can't drift from FarmFlow's auth guarantees.
    { provide: APP_GUARD, useClass: MustChangePasswordGuard },
    { provide: APP_GUARD, useClass: TenantRolesGuard },
    // Consistent error-response shapes (+ Sentry capture) with the main API.
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class EcontAppModule {}
