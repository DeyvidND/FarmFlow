import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
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
import { AuthModule } from '../auth/auth.module';
import { EcontModule } from '../econt/econt.module';
import { StandaloneAuthService } from './standalone-auth.service';
import { StandaloneAuthController } from './standalone-auth.controller';
import { EcontStandaloneController } from './econt-standalone.controller';
import { ActivationGuard } from './activation.guard';

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
    AuthModule, // JwtModule + JwtStrategy + AuthService
    EcontModule, // EcontService
  ],
  controllers: [StandaloneAuthController, EcontStandaloneController],
  providers: [
    StandaloneAuthService,
    ActivationGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class EcontAppModule {}
