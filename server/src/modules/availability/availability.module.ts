import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { AvailabilityController, PublicAvailabilityController } from './availability.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';

@Module({
  imports: [CatalogCacheModule],
  controllers: [AvailabilityController, PublicAvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
