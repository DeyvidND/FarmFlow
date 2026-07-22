import { Module } from '@nestjs/common';
import { SubcategoriesService } from './subcategories.service';
import {
  SubcategoriesController,
  PublicSubcategoriesController,
} from './subcategories.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';
import { ImageQueueRegistrationModule } from '../../common/queue/image-queue-registration.module';

@Module({
  imports: [CatalogCacheModule, ImageQueueRegistrationModule],
  controllers: [SubcategoriesController, PublicSubcategoriesController],
  providers: [SubcategoriesService],
  exports: [SubcategoriesService],
})
export class SubcategoriesModule {}
