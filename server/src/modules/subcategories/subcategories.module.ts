import { Module } from '@nestjs/common';
import { SubcategoriesService } from './subcategories.service';
import {
  SubcategoriesController,
  PublicSubcategoriesController,
} from './subcategories.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';

@Module({
  imports: [CatalogCacheModule],
  controllers: [SubcategoriesController, PublicSubcategoriesController],
  providers: [SubcategoriesService],
})
export class SubcategoriesModule {}
