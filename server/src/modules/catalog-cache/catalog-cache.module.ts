import { Module } from '@nestjs/common';
import { CatalogCacheService } from './catalog-cache.service';

@Module({
  providers: [CatalogCacheService],
  exports: [CatalogCacheService],
})
export class CatalogCacheModule {}
