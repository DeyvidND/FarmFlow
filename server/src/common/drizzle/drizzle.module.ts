import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDb, type Database } from '@farmflow/db';
import { DB_TOKEN } from './drizzle.constants';

@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createDb(config.getOrThrow<string>('DATABASE_URL'), {
          max: config.get<number>('DB_POOL_MAX', 10),
        }),
    },
  ],
  exports: [DB_TOKEN],
})
export class DrizzleModule implements OnModuleDestroy {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  // Drain the pg pool on shutdown so a rolling deploy closes connections cleanly
  // instead of leaking them until Postgres times them out. drizzle exposes the
  // underlying pg Pool as `$client`.
  async onModuleDestroy(): Promise<void> {
    await (this.db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  }
}
