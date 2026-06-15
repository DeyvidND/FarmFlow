import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import IORedis from 'ioredis';

// Captured from the forRootAsync factory so it can be closed on shutdown. BullMQ
// treats a caller-supplied connection as externally owned and never quits it
// itself, so without this the dedicated client lingers past the SIGTERM grace
// window. Module-scoped (the BullMQ root factory runs exactly once).
let bullConnection: IORedis | undefined;

/**
 * BullMQ root. Uses a DEDICATED Redis connection (not the shared REDIS_TOKEN
 * client): BullMQ workers require `maxRetriesPerRequest: null`, which the cache/
 * throttler client must not have. Same REDIS_URL, separate client — closed on
 * shutdown by {@link QueueModule.onModuleDestroy}.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        bullConnection = new IORedis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        });
        // Cast to any: pnpm resolves two ioredis minor versions (5.10 for bullmq,
        // 5.11 for server/) whose TS types diverge structurally on internal fields
        // while being runtime-compatible. Safe — BullMQ calls .on()/.quit() only.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { connection: bullConnection as any };
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule implements OnModuleDestroy {
  // Close the dedicated BullMQ connection on shutdown (mirrors
  // RedisModule.onModuleDestroy for the shared client) so a rolling deploy drains
  // cleanly instead of hanging past the termination grace period.
  async onModuleDestroy(): Promise<void> {
    await bullConnection?.quit();
  }
}
