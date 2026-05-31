import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDb } from '@farmflow/db';
import { DB_TOKEN } from './drizzle.constants';

@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createDb(config.getOrThrow<string>('DATABASE_URL')),
    },
  ],
  exports: [DB_TOKEN],
})
export class DrizzleModule {}
