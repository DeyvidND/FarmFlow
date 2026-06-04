import { Global, Module } from '@nestjs/common';
import { PublicCacheService } from './public-cache.service';

/**
 * Global so any public read service can inject {@link PublicCacheService}
 * without importing this module (mirrors RedisModule, which it depends on).
 */
@Global()
@Module({
  providers: [PublicCacheService],
  exports: [PublicCacheService],
})
export class PublicCacheModule {}
