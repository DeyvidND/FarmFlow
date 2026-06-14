import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import IORedis from 'ioredis';

/**
 * BullMQ root. Uses a DEDICATED Redis connection (not the shared REDIS_TOKEN
 * client): BullMQ workers require `maxRetriesPerRequest: null`, which the cache/
 * throttler client must not have. Same REDIS_URL, separate client.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Cast to any: pnpm resolves two ioredis minor versions (5.10 for bullmq,
        // 5.11 for server/) whose TS types diverge structurally on internal fields
        // while being runtime-compatible. The cast is safe — BullMQ calls .on()
        // and .quit() on this object; both versions implement those identically.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        connection: new IORedis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        }) as any,
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
